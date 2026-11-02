import { describe, expect, it } from 'vitest';
import { readUrlFilter } from '../api/filter-url';

describe('bounded shareable filters', () => {
  it('preserves supported nested rules, sources and explicit false values', () => {
    const filter = {
      op: 'and',
      children: [
        { op: 'tag', value: 'black_shirt', confidence: 0.8, origin: 'joytag' },
        { op: 'not', children: [{ op: 'screenshots', value: true }] },
        { op: 'duplicate', value: false },
      ],
    };
    expect(readUrlFilter(JSON.stringify(filter))).toEqual({ filter });
    expect(readUrlFilter(null)).toEqual({});
  });

  it.each([
    '{',
    'null',
    '[]',
    '{"op":"execute_sql"}',
    '{"op":"and","children":"invalid"}',
    '{"op":"not","children":[]}',
    '{"op":"tag","value":{"private":"invalid"}}',
    '{"op":"tag","value":"beach","confidence":2}',
  ])('rejects malformed filter JSON instead of silently browsing without its filters: %s', (raw) => {
    expect(readUrlFilter(raw).error).toContain('filtros deste link são inválidos');
    expect(readUrlFilter(raw).filter).toBeUndefined();
  });

  it('rejects excess depth and broad trees before the recursive editor renders', () => {
    let node: unknown = { op: 'tag', value: 'beach' };
    for (let depth = 0; depth < 10; depth += 1) node = { op: 'not', children: [node] };
    expect(readUrlFilter(JSON.stringify(node)).error).toBeTruthy();
    const broad = {
      op: 'and',
      children: Array.from({ length: 20 }, () => ({
        op: 'and',
        children: Array.from({ length: 6 }, () => ({ op: 'tag', value: 'beach' })),
      })),
    };
    expect(readUrlFilter(JSON.stringify(broad)).error).toBeTruthy();
    expect(readUrlFilter(' '.repeat(12_001)).error).toBeTruthy();
  });
});
