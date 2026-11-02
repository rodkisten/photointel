export type SecretRef = { key: string; name: string; version: string };
export type SecretsList = { items: SecretRef[]; config_version: string };
export type SecretPreview = SecretRef & { fragment: string };
export type SecretResult = {
  ok: boolean; key: string; name: string; created_version: string;
  config_updated: boolean;
  dispatches: Array<{ file: string; status: 'queued' | 'failed' }>;
};
