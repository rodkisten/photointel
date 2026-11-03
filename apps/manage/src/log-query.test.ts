import { describe, expect, it } from 'vitest';
import { ApiError } from './auth';
import { gcpLogFilter, parseLogRequest } from './log-query';

const correlation = '4d0977df-e6c9-46a9-a8ea-5c5cca15778c';
const job = '510e985c-fb17-4294-ac63-42b7ac1c1b3c';

describe('bounded provider log queries', () => {
  it('looks for either correlated job or request ID in the event time window', () => {
    const now = Date.parse('2026-11-03T12:00:00.000Z');
    const at = '2026-11-03T11:00:00.000Z';
    const params = new URLSearchParams({ correlation, job, at, minutes: '30' });
    const request = parseLogRequest(params, now);
    expect(request.start).toBe(Date.parse(at) - 15 * 60_000);
    expect(request.end).toBe(Date.parse(at) + 15 * 60_000);
    const filter = gcpLogFilter(request);
    expect(filter).toContain('SEARCH("' + correlation + '") OR SEARCH("' + job + '")');
    expect(filter).toContain('resource.type="cloud_run_job"');
    expect(filter).toContain('2026-11-03T10:45:00.000Z');
    const exact = gcpLogFilter(
      parseLogRequest(new URLSearchParams({ entry: 'insert-9876', minutes: '15' }), now),
    );
    expect(exact).toContain('insertId="insert-9876"');
    expect(exact).not.toContain('severity>=WARNING');
  });
  it('does not allow query injection, invalid IDs or excessive windows', () => {
    for (const params of [
      new URLSearchParams({ correlation: 'hello" OR true', minutes: '30' }),
      new URLSearchParams({ search: 'foo bar', minutes: '30' }),
      new URLSearchParams({ minutes: '999999' }),
    ])
      expect(() => parseLogRequest(params)).toThrow(ApiError);
  });
  it('shows only warnings for the unfiltered general feed', () => {
    const filter = gcpLogFilter(parseLogRequest(new URLSearchParams({ minutes: '15' })));
    expect(filter).toContain('severity>=WARNING');
    expect(filter).not.toContain('SEARCH(');
  });
});
