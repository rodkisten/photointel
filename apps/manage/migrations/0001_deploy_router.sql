-- Persistent deployment policies and event inbox. Run with Wrangler migrations before Worker publish.
CREATE TABLE IF NOT EXISTS deploy_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  provider TEXT NOT NULL CHECK (provider IN ('cloudflare','gcp')),
  target TEXT NOT NULL,
  patterns_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deploy_deliveries (
  id TEXT PRIMARY KEY,
  sha TEXT NOT NULL,
  changed_files TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deploy_runs (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deploy_deliveries(id) ON DELETE CASCADE,
  rule_id TEXT REFERENCES deploy_rules(id) ON DELETE SET NULL,
  rule_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  target TEXT NOT NULL,
  sha TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  provider_id TEXT,
  status_url TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(delivery_id,rule_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deploy_runs_route_sha ON deploy_runs(rule_id,sha);
CREATE INDEX IF NOT EXISTS idx_deploy_runs_state ON deploy_runs(state,created_at);
CREATE INDEX IF NOT EXISTS idx_deploy_runs_created ON deploy_runs(created_at DESC);
