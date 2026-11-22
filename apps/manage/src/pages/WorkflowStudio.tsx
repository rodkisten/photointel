import { useCallback, useEffect, useRef, useState } from 'react';
import { api, send } from '../lib/client';
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, addEdge, applyEdgeChanges, applyNodeChanges, type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Button, Card, Input, Select } from '../components/ui';

type Step = Record<string, unknown> & { label: string; kind: 'trigger' | 'github' | 'condition' | 'deploy' | 'notify' };
type StepNode = Node<Step, 'step'>;
const defaults: StepNode[] = [
  { id: 'start', type: 'step', position: { x: 100, y: 50 }, data: { label: 'Manual trigger', kind: 'trigger' } },
  { id: 'build', type: 'step', position: { x: 100, y: 190 }, data: { label: 'GitHub Actions', kind: 'github' } },
  { id: 'check', type: 'step', position: { x: 100, y: 330 }, data: { label: 'Check result', kind: 'condition' } },
];
function StepCard({ data, selected }: NodeProps<StepNode>) {
  return <div className={`min-w-48 rounded-xl border bg-carbon-950 p-4 text-xs text-carbon-100 shadow-xl ${selected ? 'border-white' : 'border-carbon-700'}`}>
    <Handle type="target" position={Position.Top} />
    <span className="block text-[10px] uppercase tracking-wider text-carbon-400">{data.kind}</span>
    <span className="font-semibold">{data.label}</span>
    {data.kind === 'condition' ? <>
      <Handle id="success" type="source" position={Position.Bottom} style={{ left: '30%', background: '#34d399' }} />
      <Handle id="failure" type="source" position={Position.Bottom} style={{ left: '70%', background: '#fb7185' }} />
      <div className="mt-3 flex justify-between text-[10px]"><span>Success</span><span>Failure</span></div>
    </> : <Handle type="source" position={Position.Bottom} />}
  </div>;
}
const nodeTypes = { step: StepCard };
type FlowGraph = { version: 1; name: string; nodes: StepNode[]; edges: Edge[] };
type SavedFlow = { id: string; name: string; graph: FlowGraph; revision: number };
type FlowList = { items: SavedFlow[] };
export function WorkflowStudio() {
  const [name, setName] = useState('Production pipeline');
  const [kind, setKind] = useState<Step['kind']>('github');
  const [nodes, setNodes] = useState<StepNode[]>(defaults);
  const [edges, setEdges] = useState<Edge[]>([
    { id: 'start-build', source: 'start', target: 'build' },
    { id: 'build-check', source: 'build', target: 'check' },
  ]);
  const [selected, setSelected] = useState<string | null>(null);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [saved, setSaved] = useState<SavedFlow[]>([]);
  const [status, setStatus] = useState('Carregando diagramas...');
  const [dirty, setDirty] = useState(false);
  const [ready, setReady] = useState(false);
  const [saveEpoch, setSaveEpoch] = useState(0);
  const saving = useRef(false);
  const latest = useRef({ name, nodes, edges });
  useEffect(() => { latest.current = { name, nodes, edges }; }, [name, nodes, edges]);
  const suppress = useRef(false);
  const markDirty = useCallback(() => { if (!suppress.current) setDirty(true); }, []);
  useEffect(() => {
    let alive = true;
    api<FlowList>('/workflow-studio/flows').then((data) => {
      if (!alive) return;
      setSaved(data.items);
      setStatus(data.items.length ? 'Selecione um diagrama ou crie um novo.' : 'Novo diagrama ainda não salvo.');
      setReady(true);
    }).catch((error: Error) => { if (alive) { setStatus('Erro ao carregar: ' + error.message); setReady(true); } });
    return () => { alive = false; };
  }, []);
  const load = (flow: SavedFlow) => {
    if (dirty && !window.confirm('Descartar alterações não salvas?')) return;
    suppress.current = true;
    setFlowId(flow.id); setRevision(flow.revision);
    setName(flow.graph.name); setNodes(flow.graph.nodes); setEdges(flow.graph.edges);
    setSelected(null); setDirty(false); setStatus('Diagrama carregado.');
    queueMicrotask(() => { suppress.current = false; });
  };
  const newFlow = () => {
    if (dirty && !window.confirm('Descartar alterações não salvas?')) return;
    suppress.current = true;
    setFlowId(null); setRevision(null); setName('Novo workflow'); setNodes([]);
    setEdges([]); setSelected(null); setDirty(false); setStatus('Novo diagrama. Adicione nós para começar.');
    queueMicrotask(() => { suppress.current = false; });
  };
  const save = async () => {
    if (saving.current || !ready) return;
    saving.current = true;
    const snapshot = latest.current;
    const graph: FlowGraph = { version: 1, ...snapshot };
    setStatus('Salvando...');
    try {
      if (!flowId) {
        const result = await send<{ id: string; revision: number }>('/workflow-studio/flows', graph);
        setFlowId(result.id); setRevision(result.revision);
        setSaved((prev) => [{ id: result.id, revision: result.revision, name: graph.name, graph }, ...prev]);
      } else {
        if (revision === null) throw new Error('Revisão desconhecida');
        const result = await send<{ revision: number }>('/workflow-studio/flows/' + flowId, { graph, revision }, 'PUT');
        setRevision(result.revision);
        setSaved((prev) => prev.map((item) => item.id === flowId ? { ...item, revision: result.revision, name: graph.name, graph } : item));
      }
      const changedDuringSave = latest.current.name !== snapshot.name || latest.current.nodes !== snapshot.nodes || latest.current.edges !== snapshot.edges;
      setDirty(changedDuringSave);
      setStatus(changedDuringSave ? 'Novas alterações aguardando salvamento.' : 'Salvo no D1.');
    } catch (error) {
      setStatus('Não salvo: ' + (error instanceof Error ? error.message : String(error)));
    } finally { saving.current = false; setSaveEpoch((n) => n + 1); }
  };
  useEffect(() => {
    if (!ready || !dirty) return;
    const timer = window.setTimeout(() => { void save(); }, 1200);
    return () => window.clearTimeout(timer);
  }, [ready, dirty, name, nodes, edges, flowId, revision, saveEpoch]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const onNodesChange = useCallback((changes: NodeChange<StepNode>[]) => (markDirty(), setNodes((old) => applyNodeChanges(changes, old))), []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => (markDirty(), setEdges((old) => applyEdgeChanges(changes, old))), []);
  const onConnect = useCallback((connection: Connection) => {
    if (connection.source !== connection.target) { markDirty(); setEdges((old) => addEdge(connection, old)); }
  }, [markDirty]);
  const add = () => {
    const id = crypto.randomUUID();
    setNodes((old) => [...old, { id, type: 'step', position: { x: 150, y: 100 + old.length * 90 }, data: { label: kind, kind } }]);
    setSelected(id); markDirty();
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, name, nodes, edges }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'workflow.json'; a.click();
    URL.revokeObjectURL(url);
  };
  const active = nodes.find((node) => node.id === selected);
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold text-carbon-100">Workflow Studio</h1><p className="text-xs text-carbon-400">Visual editor · no deployments are executed</p></div><Button size="sm" variant="outline" onClick={download}>Export JSON</Button></div>
    <div className="flex flex-wrap gap-2">
      <Select aria-label="Saved workflows" className="max-w-72" value={flowId || ''} onChange={(event) => { const item = saved.find((entry) => entry.id === event.target.value); if (item) load(item); }}>
        <option value="">Novo diagrama</option>
        {saved.map((flow) => <option key={flow.id} value={flow.id}>{flow.name} · r{flow.revision}</option>)}
      </Select>
      <Button size="sm" variant="outline" onClick={newFlow}>Novo</Button>
      <Button size="sm" onClick={() => void save()} disabled={!ready}>Salvar</Button>
      <span role="status" aria-live="polite" className="self-center text-xs text-carbon-400">{status}{dirty ? ' · alterações pendentes' : ''}</span>
    </div>
    <Input aria-label="Workflow name" value={name} onChange={(event) => { setName(event.target.value); markDirty(); }} />
    <div className="flex gap-2"><Select aria-label="Node type" className="max-w-48" value={kind} onChange={(event) => setKind(event.target.value as Step['kind'])}>{(['trigger','github','condition','deploy','notify'] as const).map((value) => <option key={value} value={value}>{value}</option>)}</Select><Button size="sm" variant="secondary" onClick={add}>Add node</Button></div>
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_240px]">
      <div className="h-[65vh] min-h-[420px] overflow-hidden rounded-xl border border-carbon-800 bg-carbon-950">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_,node)=>setSelected(node.id)} onPaneClick={()=>setSelected(null)} fitView colorMode="dark">
          <Background color="#30343b" gap={18} /><Controls /><MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      <Card className="h-fit space-y-3 p-4"><h2 className="text-sm font-semibold text-carbon-100">Node settings</h2>{active ? <><Input aria-label="Node label" value={active.data.label} onChange={(event)=>{setNodes((old)=>old.map((node)=>node.id===active.id?{...node,data:{...node.data,label:event.target.value}}:node));markDirty();}}/><Button variant="destructive" size="sm" onClick={()=>{setNodes((old)=>old.filter((node)=>node.id!==active.id));setEdges((old)=>old.filter((edge)=>edge.source!==active.id&&edge.target!==active.id));setSelected(null);markDirty();}}>Remove node</Button></> : <p className="text-xs text-carbon-400">Select a node to edit it.</p>}</Card>
    </div>
  </div>;
}
