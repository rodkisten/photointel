CREATE TABLE IF NOT EXISTS userscript_errors (
  fingerprint TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  script TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT NOT NULL DEFAULT '',
  page_url TEXT NOT NULL DEFAULT '',
  request_json TEXT,
  response_json TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_userscript_errors_last_seen
  ON userscript_errors(repository, last_seen DESC);
