import { appendFileSync, readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('infra/gcp/config.local.json', 'utf8'));
if (config.project_id !== process.env.CONFIRM_PROJECT) throw new Error('Project confirmation mismatch');
const extra = config.extra_environment ?? {};
const dsn = String(extra.MANAGE_SENTRY_DSN ?? '').trim();
const org = String(extra.SENTRY_ORG ?? '').trim();
if (org && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(org)) throw new Error('Invalid Sentry organization');
if (dsn) {
  const u = new URL(dsn);
  if (u.protocol !== 'https:' || !/^[a-f0-9]{12,64}$/i.test(u.username) || u.password || !u.hostname.endsWith('.sentry.io') || !/^\/[0-9]+\/?$/.test(u.pathname) || u.search || u.hash) throw new Error('Invalid public Sentry DSN');
}
const output = process.env.GITHUB_ENV;
if (!output) throw new Error('GITHUB_ENV unavailable');
const sha = process.env.PHOTOINTEL_BUILD_SHA ?? process.env.GITHUB_SHA ?? '';
const values = { VITE_MANAGE_SENTRY_DSN: dsn, VITE_MANAGE_SENTRY_ORG: org, VITE_MANAGE_RELEASE: /^[a-f0-9]{40}$/.test(sha) ? sha : '' };
appendFileSync(output, Object.entries(values).filter(([,v]) => v).map(([k,v]) => k+'='+v+'\n').join(''));
console.log('Manage browser Sentry ingest:', dsn ? 'configured' : 'disabled');
