import { describe, expect, it } from 'vitest';
import { safeArray, safeList } from './api-utils';

describe('safeList', () => {
  it('returns only object entries from an envelope array', () => {
    expect(safeList({ items: [{ id: 1 }, null, 'invalid', { id: 2 }] }, 'items'))
      .toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('returns an empty array for absent or malformed envelopes', () => {
    expect(safeList(null, 'items')).toEqual([]);
    expect(safeList(undefined, 'items')).toEqual([]);
    expect(safeList({ items: 'not-an-array' }, 'items')).toEqual([]);
    expect(safeList([{ id: 1 }], 'items')).toEqual([]);
  });

  it('supports concrete response contracts', () => {
    const runs = safeList<{ id?: number; actor?: { login?: string } }>(
      { workflow_runs: [{ id: 42, actor: { login: 'rod' } }] }, 'workflow_runs',
    );
    expect(runs[0]?.id).toBe(42);
    expect(runs[0]?.actor?.login).toBe('rod');
  });
});

describe('safeArray', () => {
  it('validates direct arrays and rejects non-object entries', () => {
    expect(safeArray([{ id: 'evt-1' }, null, 2, { id: 'evt-2' }]))
      .toEqual([{ id: 'evt-1' }, { id: 'evt-2' }]);
  });

  it('returns an empty array for non-array values', () => {
    expect(safeArray({ items: [] })).toEqual([]);
    expect(safeArray(null)).toEqual([]);
  });
});
