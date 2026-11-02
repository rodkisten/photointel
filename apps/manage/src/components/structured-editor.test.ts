import { describe, expect, it } from 'vitest';
import { asStructuredData, makeJsonViewHighlightPattern } from './json-view';
import { detectEnvironmentFormat } from './codemirror-env-editor';

describe('structured log viewer and env editor', () => {
  it('parses JSON payloads but retains arbitrary text logs', () => {
    expect(asStructuredData('{"status":500,"reason":"down"}')).toEqual({ status: 500, reason: 'down' });
    expect(asStructuredData('[1,2,3]')).toEqual([1, 2, 3]);
    expect(asStructuredData('POST /api/jobs {"status":500}')).toBe('POST /api/jobs {"status":500}');
    expect(asStructuredData('{invalid')).toBe('{invalid');
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
