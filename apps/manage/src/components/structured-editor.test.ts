import { describe, expect, it } from 'vitest';
import { asStructuredData, isEmptyJsonValue, makeJsonViewHighlightPattern } from './json-view';
import { mapCloudLogs } from '../providers';
import { detectEnvironmentFormat } from './codemirror-env-editor';

describe('structured log viewer and env editor', () => {
  it('parses JSON payloads but retains arbitrary text logs', () => {
    expect(asStructuredData('{"status":500,"reason":"down"}')).toEqual({ status: 500, reason: 'down' });
    expect(asStructuredData('[1,2,3]')).toEqual([1, 2, 3]);
    expect(asStructuredData('POST /api/jobs {"status":500}')).toBe('POST /api/jobs {"status":500}');
    expect(asStructuredData('{invalid')).toBe('{invalid');
  });
  it('does not mount a JSON tree for empty payloads', () => {
    for (const payload of [null, undefined, '', '   ', '{}', '[]', {}, []]) {
      expect(isEmptyJsonValue(payload)).toBe(true);
    }
    expect(isEmptyJsonValue('request failed')).toBe(false);
    expect(isEmptyJsonValue({ code: 'HTTP_409' })).toBe(false);
  });
  it('shows HTTP context when Cloud Logging has no text or JSON payload', () => {
    const items = mapCloudLogs([
      {
        timestamp: '2026-11-03T12:00:00Z',
        severity: 'WARNING',
        jsonPayload: {},
        httpRequest: { requestMethod: 'POST', status: 409, latency: '0.01s' },
      },
      { severity: 'WARNING', jsonPayload: {} },
    ]);
    expect(JSON.parse(String(items[0].message)).httpRequest).toMatchObject({
      method: 'POST',
      status: 409,
    });
    expect(items[1].message).toBe('');
  });
  it('highlights literal search queries including regex metacharacters', () => {
    expect('abc [500] end'.match(makeJsonViewHighlightPattern('[500]')!)).toEqual(['[500]']);
    expect('abc abc'.match(makeJsonViewHighlightPattern('AbC')!)).toEqual(['abc', 'abc']);
    expect(makeJsonViewHighlightPattern('   ')).toBeNull();
  });
  it('auto-detects JSON and dotenv without modifying source text', () => {
    expect(detectEnvironmentFormat('  { "a": 1 }')).toBe('json');
    expect(detectEnvironmentFormat('# comment\nA=json:true\n')).toBe('dotenv');
  });
});
