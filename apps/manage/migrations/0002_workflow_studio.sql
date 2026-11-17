-- Workflow Studio definitions. Drafts only: no deployment is executed by saving a graph.
CREATE TABLE IF NOT EXISTS workflow_studio_flows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  graph_json TEXT NOT NULL CHECK (json_valid(graph_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_studio_flows_updated ON workflow_studio_flows(updated_at DESC);
