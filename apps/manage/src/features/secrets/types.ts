export type SecretRef = {
  scope: 'secrets' | 'workflow_secrets' | 'expected';
  key: string;
  name: string;
  version: string;
};
export type SecretItem = {
  name: string;
  exists: boolean | 'unknown';
  references: SecretRef[];
  created_at?: string;
};
export type SecretsList = {
  items: SecretItem[];
  config_version: string;
  warning?: string;
};
export type SecretPreview = { name: string; version: string; fragment: string };
export type SecretVersion = {
  version: string;
  state: string;
  created_at?: string;
  destroyed_at?: string;
};
export type SecretVersions = { items: SecretVersion[]; next_page_token: string };
export type SecretResult = {
  ok: boolean;
  name: string;
  created_version: string;
  config_updated: boolean;
  dispatches: Array<{ file: string; status: 'queued' | 'failed' }>;
  manual: string[];
};
export type SecretActivation = {
  ok: boolean;
  name: string;
  activated_version: string;
  dispatches: Array<{ file: string; status: 'queued' | 'failed' }>;
  manual: string[];
};
