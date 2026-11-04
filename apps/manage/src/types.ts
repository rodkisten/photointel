export type Tab = 'overview' | 'deploy' | 'infrastructure' | 'costs' | 'logs' | 'config' | 'secrets' | 'icloud' | 'settings';
export type Meta = {
  email: string;
  repo: string;
  project: string;
  gcp: boolean;
  cloudflare: boolean;
  sentry: boolean;
  sentry_reader?: boolean;
  sentry_org?: string;
  cloudflare_account_id?: string;
  gcp_region?: string;
};
export type Run = {
  id: number;
  name: string;
  display_title?: string;
  status: string;
  conclusion?: string;
  created_at: string;
  updated_at?: string;
  html_url: string;
  run_number: number;
  event?: string;
  actor?: string;
  head_sha?: string;
};
export type WF = {
  id: number;
  name: string;
  file: string;
  state: string;
  html_url: string;
  inputs: Record<string, string[]>;
};
export type Job = {
  id: number;
  name: string;
  status: string;
  conclusion?: string;
  html_url: string;
  started_at?: string;
  steps: { name: string; number: number; conclusion: string; status: string }[];
};
export type CloudLog = {
  timestamp: string;
  severity: string;
  service: string;
  resource?: string;
  message: string;
  insertId?: string;
};
export type CfLog = {
  id: string;
  timestamp: number;
  service: string;
  severity: string;
  message: string;
  outcome: string;
};
export type Issue = {
  id: string;
  title: string;
  level: string;
  count: string;
  lastSeen: string;
  permalink: string;
  culprit: string;
  project: string;
};
