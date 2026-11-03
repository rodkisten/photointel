/** Public URL contract for exact, shareable, read-only investigations. */
export type LogSource = 'gcp' | 'cloudflare' | 'github' | 'sentry';
export interface LogLink {
  source: LogSource;
  correlation: string;
  job: string;
  jobType: string;
  ray: string;
  event: string;
  entry: string;
  at: string;
  search: string;
  minutes: string;
}
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const TERM = /^[A-Za-z0-9_.:-]{1,100}$/;
const RAY = /^[a-f0-9-]{8,64}$/i;
const EVENT = /^[a-f0-9]{32}$/i;
const JOB_TYPE = /^[a-z0-9_]{1,48}$/;

function safeDate(value: string | null): string {
  if (!value || value.length > 40 || Number.isNaN(Date.parse(value))) return '';
  const timestamp = new Date(value);
  // Do not accept anchor dates outside providers' supported retention window.
  if (timestamp.getTime() > Date.now() + 60_000 || timestamp.getTime() < Date.now() - 7 * 86400_000)
    return '';
  return timestamp.toISOString();
}

export function readLogLink(search: string): LogLink {
  const params = new URLSearchParams(search);
  const source = params.get('source');
  const correlation = params.get('correlation') || '';
  const job = params.get('job') || '';
  const ray = params.get('ray') || '';
  const event = params.get('event') || '';
  const query = params.get('search') || '';
  const entry = params.get('entry') || '';
  const minutes = params.get('minutes') || '';
  const at = safeDate(params.get('at'));
  const link: LogLink = {
    source: source === 'cloudflare' || source === 'github' || source === 'sentry' ? source : 'gcp',
    correlation: UUID.test(correlation) ? correlation : '',
    job: UUID.test(job) ? job : '',
    jobType: JOB_TYPE.test(params.get('job_type') || '') ? params.get('job_type')! : '',
    ray: RAY.test(ray) ? ray : '',
    event: EVENT.test(event) ? event : '',
    entry: TERM.test(entry) ? entry : '',
    at,
    search: TERM.test(query) ? query : '',
    minutes: ['15', '30', '60', '240', '1440', '10080'].includes(minutes) ? minutes : '30',
  };
  if (!minutes && (link.correlation || link.job || link.ray || link.event || link.entry || link.search)) {
    link.minutes = at ? '30' : '10080';
  }
  return link;
}

export function primaryTerm(link: LogLink): string {
  return link.entry || link.correlation || link.job || link.ray || link.event || link.search;
}

export function logLinkPath(link: LogLink): string {
  const params = new URLSearchParams({ source: link.source });
  for (const [key, value] of [
    ['correlation', link.correlation],
    ['job', link.job],
    ['job_type', link.jobType],
    ['ray', link.ray],
    ['event', link.event],
    ['entry', link.entry],
    ['at', link.at],
    ['search', link.search],
  ])
    if (value) params.set(key, value);
  params.set('minutes', link.minutes);
  return '/logs?' + params.toString();
}

/** Only identifiers and a bounded time window reach provider queries. */
export function apiLogParams(link: LogLink, editedTerm: string): URLSearchParams {
  const params = new URLSearchParams({ minutes: link.minutes });
  if (link.at) params.set('at', link.at);
  if (editedTerm === primaryTerm(link)) {
    if (link.correlation) params.set('correlation', link.correlation);
    if (link.job) params.set('job', link.job);
    if (link.ray) params.set('ray', link.ray);
    if (link.event) params.set('event', link.event);
    if (link.entry) params.set('entry', link.entry);
    if (link.search) params.set('search', link.search);
  } else if (TERM.test(editedTerm)) {
    params.set('search', editedTerm);
  }
  return params;
}
