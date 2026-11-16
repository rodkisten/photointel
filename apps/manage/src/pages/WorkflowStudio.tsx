import { useCallback, useState } from 'react';
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, addEdge, applyEdgeChanges, applyNodeChanges, type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Button, Card, Input, Select } from '../components/ui';

type Step = { label: string; kind: 'trigger' | 'github' | 'condition' | 'deploy' | 'notify' };
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
export function WorkflowStudio() {
  const [name, setName] = useState('Production pipeline');
  const [kind, setKind] = useState<Step['kind']>('github');
  const [nodes, setNodes] = useState<StepNode[]>(defaults);
  const [edges, setEdges] = useState<Edge[]>([
    { id: 'start-build', source: 'start', target: 'build' },
    { id: 'build-check', source: 'build', target: 'check' },
  ]);
  const [selected, setSelected] = useState<string | null>(null);
  const onNodesChange = useCallback((changes: NodeChange<StepNode>[]) => setNodes((old) => applyNodeChanges(changes, old)), []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges((old) => applyEdgeChanges(changes, old)), []);
  const onConnect = useCallback((connection: Connection) => {
    if (connection.source !== connection.target) setEdges((old) => addEdge(connection, old));
  }, []);
  const add = () => {
    const id = crypto.randomUUID();
    setNodes((old) => [...old, { id, type: 'step', position: { x: 150, y: 100 + old.length * 90 }, data: { label: kind, kind } }]);
    setSelected(id);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, name, nodes, edges }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'workflow.json'; a.click();
    URL.revokeObjectURL(url);
  };
  const active = nodes.find((node) => node.id === selected);
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold text-carbon-100">Workflow Studio</h1><p className="text-xs text-carbon-400">Visual editor · no deployments are executed</p></div><Button size="sm" variant="outline" onClick={download}>Export JSON</Button></div>
    <Input aria-label="Workflow name" value={name} onChange={(event) => setName(event.target.value)} />
    <div className="flex gap-2"><Select aria-label="Node type" className="max-w-48" value={kind} onChange={(event) => setKind(event.target.value as Step['kind'])}>{(['trigger','github','condition','deploy','notify'] as const).map((value) => <option key={value} value={value}>{value}</option>)}</Select><Button size="sm" variant="secondary" onClick={add}>Add node</Button></div>
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_240px]">
      <div className="h-[65vh] min-h-[420px] overflow-hidden rounded-xl border border-carbon-800 bg-carbon-950">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_,node)=>setSelected(node.id)} onPaneClick={()=>setSelected(null)} fitView colorMode="dark">
          <Background color="#30343b" gap={18} /><Controls /><MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      <Card className="h-fit space-y-3 p-4"><h2 className="text-sm font-semibold text-carbon-100">Node settings</h2>{active ? <><Input aria-label="Node label" value={active.data.label} onChange={(event)=>setNodes((old)=>old.map((node)=>node.id===active.id?{...node,data:{...node.data,label:event.target.value}}:node))}/><Button variant="destructive" size="sm" onClick={()=>{setNodes((old)=>old.filter((node)=>node.id!==active.id));setEdges((old)=>old.filter((edge)=>edge.source!==active.id&&edge.target!==active.id));setSelected(null);}}>Remove node</Button></> : <p className="text-xs text-carbon-400">Select a node to edit it.</p>}</Card>
    </div>
  </div>;
}
