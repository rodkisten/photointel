import { ApiError, bodyJson, json } from './auth';
import type { Env } from './auth';

type Graph = {
  version: number;
  name: string;
  nodes: Array<{ id: string; type?: string; position: { x: number; y: number }; data: { kind: string; label: string } }>;
  edges: Array<{ id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }>;
};
type Row = { id: string; name: string; graph_json: string; revision: number; created_at: string; updated_at: string };
const KINDS = new Set(['trigger', 'github', 'condition', 'deploy', 'notify']);
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
function validate(raw: unknown): Graph {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(422, 'GRAPH_INVALID', 'Diagrama inválido');
  const graph = raw as Graph;
  if (graph.version !== 1 || typeof graph.name !== 'string' || !graph.name.trim() || graph.name.length > 100)
    throw new ApiError(422, 'GRAPH_NAME', 'Nome inválido ou versão não suportada');
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length > 150 || graph.edges.length > 300)
    throw new ApiError(422, 'GRAPH_LIMIT', 'Limite de nós ou conexões excedido');
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || !ID.test(node.id) || ids.has(node.id) ||
      !node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y) ||
      !node.data || !KINDS.has(node.data.kind) || typeof node.data.label !== 'string' || node.data.label.length > 100)
      throw new ApiError(422, 'GRAPH_NODE', 'Nó inválido');
    ids.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (!edge || typeof edge.id !== 'string' || !ID.test(edge.id) || edgeIds.has(edge.id) ||
      !ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target ||
      (edge.sourceHandle != null && !['success', 'failure'].includes(edge.sourceHandle)) ||
      (edge.targetHandle != null && edge.targetHandle !== ''))
      throw new ApiError(422, 'GRAPH_EDGE', 'Conexão inválida');
    edgeIds.add(edge.id);
  }
  return {
    version: 1, name: graph.name.trim(),
    nodes: graph.nodes.map(n => ({ id: n.id, type: 'step', position: { x: n.position.x, y: n.position.y }, data: { kind: n.data.kind, label: n.data.label } })),
    edges: graph.edges.map(e => ({ id: e.id, source: e.source, target: e.target, ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}) })),
  };
}
function database(env: Env) {
  if (!env.DEPLOY_DB) throw new ApiError(503, 'D1_MISSING', 'Banco DEPLOY_DB não configurado');
  return env.DEPLOY_DB;
}
function toItem(row: Row) {
  return { id: row.id, name: row.name, graph: JSON.parse(row.graph_json) as Graph, revision: row.revision, created_at: row.created_at, updated_at: row.updated_at };
}
export async function workflowStudioRoute(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/workflow-studio/')) return null;
  const db = database(env);
  const method = request.method.toUpperCase();
  if (path === '/api/workflow-studio/flows' && method === 'GET') {
    const result = await db.prepare('SELECT id,name,graph_json,revision,created_at,updated_at FROM workflow_studio_flows ORDER BY updated_at DESC LIMIT 100').all<Row>();
    return json({ items: result.results.map(toItem) });
  }
  if (path === '/api/workflow-studio/flows' && method === 'POST') {
    const graph = validate(await bodyJson<unknown>(request, 120_000));
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    await db.prepare('INSERT INTO workflow_studio_flows(id,name,graph_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .bind(id, graph.name, JSON.stringify(graph), 1, timestamp, timestamp).run();
    return json({ id, revision: 1 }, 201);
  }
  const match = path.match(/^\/api\/workflow-studio\/flows\/([a-f0-9-]{36})$/);
  if (match) {
    const id = match[1];
    if (method === 'GET') {
      const row = await db.prepare('SELECT id,name,graph_json,revision,created_at,updated_at FROM workflow_studio_flows WHERE id=?').bind(id).first<Row>();
      if (!row) throw new ApiError(404, 'FLOW_NOT_FOUND', 'Workflow não encontrado');
      return json(toItem(row));
    }
    if (method === 'PUT') {
      const body = await bodyJson<{ graph: unknown; revision: number }>(request, 120_000);
      const graph = validate(body.graph);
      if (!Number.isSafeInteger(body.revision) || body.revision < 1) throw new ApiError(422, 'FLOW_REVISION', 'Revisão inválida');
      const updated = await db.prepare('UPDATE workflow_studio_flows SET name=?,graph_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?')
        .bind(graph.name, JSON.stringify(graph), new Date().toISOString(), id, body.revision).run();
      if (updated.meta?.changes !== 1) throw new ApiError(409, 'FLOW_CONFLICT', 'Workflow alterado em outra sessão; recarregue antes de salvar');
      return json({ id, revision: body.revision + 1 });
    }
    if (method === 'DELETE') {
      const deleted = await db.prepare('DELETE FROM workflow_studio_flows WHERE id=?').bind(id).run();
      if (deleted.meta?.changes !== 1) throw new ApiError(404, 'FLOW_NOT_FOUND', 'Workflow não encontrado');
      return json({ deleted: true });
    }
  }
  throw new ApiError(404, 'STUDIO_ROUTE', 'Rota não encontrada');
}
