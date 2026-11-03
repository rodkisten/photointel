import { describe, expect, it } from 'vitest';
import { apiLogParams, logLinkPath, primaryTerm, readLogLink } from './log-deeplink';

const correlation = '4d0977df-e6c9-46a9-a8ea-5c5cca15778c';
const job = '510e985c-fb17-4294-ac63-42b7ac1c1b3c';

describe('Manage log URL contract', () => {
  it('opens the requested provider and keeps all exact identifiers', () => {
    const params = '?tab=logs&source=gcp&correlation=' + correlation + '&job=' + job + '&job_type=thumbnail_generate';
    const link = readLogLink(params);
    expect(link.source).toBe('gcp');
    expect(link.correlation).toBe(correlation);
    expect(link.job).toBe(job);
    expect(link.jobType).toBe('thumbnail_generate');
    expect(link.minutes).toBe('10080');
    expect(primaryTerm(link)).toBe(correlation);
    const query = apiLogParams(link, primaryTerm(link));
    expect(query.get('job')).toBe(job);
    expect(query.get('correlation')).toBe(correlation);
    expect(readLogLink(logLinkPath(link).split('?')[1]).job).toBe(job);
    const exact = readLogLink(logLinkPath({ ...link, entry: 'insertId-123' }));
    expect(exact.entry).toBe('insertId-123');
    expect(primaryTerm(exact)).toBe('insertId-123');
    expect(apiLogParams(exact, primaryTerm(exact)).get('entry')).toBe('insertId-123');
  });
  it('rejects malformed or unsafe URL fields', () => {
    const link = readLogLink('?source=https://evil.invalid&job=x%22%29&search=%22%20OR%20true&ray=../');
    expect(link.source).toBe('gcp');
    expect(link.job).toBe('');
    expect(link.ray).toBe('');
    expect(link.search).toBe('');
    expect(apiLogParams(link, 'bad" query').get('search')).toBeNull();
  });
  it('keeps a bounded event-time anchor and supports plain correlation links', () => {
    const at = new Date(Date.now() - 60000).toISOString();
    const link = readLogLink('?source=cloudflare&correlation=' + correlation + '&at=' + encodeURIComponent(at));
    expect(link.at).toBe(at);
    expect(link.minutes).toBe('30');
    expect(apiLogParams(link, primaryTerm(link)).get('at')).toBe(at);
    expect(readLogLink('?source=cloudflare&correlation=' + correlation).minutes).toBe('10080');
  });
});
