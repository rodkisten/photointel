import type { FilterNode } from './types';

const operations = new Set([
  'and',
  'or',
  'not',
  'tag',
  'text',
  'date',
  'number',
  'media_type',
  'source',
  'album',
  'duplicate',
  'quality',
  'screenshots',
]);
const comparisons = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']);
const origins = new Set(['apple', 'joytag', 'user', 'import', 'external']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const scalar = (value: unknown) =>
  value === null ||
  value === undefined ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

/** Bound recursive URL data before the editor renders or makes an API request. */
export function readUrlFilter(raw: string | null): {
  filter?: FilterNode;
  error?: string;
} {
  if (!raw) return {};
  try {
    if (raw.length > 12_000) throw new Error('size');
    const parsed: unknown = JSON.parse(raw);
    const stack: { value: unknown; depth: number }[] = [{ value: parsed, depth: 0 }];
    let count = 0;
    while (stack.length) {
      const { value, depth } = stack.pop()!;
      count += 1;
      if (
        depth > 8 ||
        count > 100 ||
        !isRecord(value) ||
        typeof value.op !== 'string' ||
        !operations.has(value.op)
      )
        throw new Error('node');
      if (
        !scalar(value.value) ||
        !scalar(value.minimum) ||
        !scalar(value.maximum) ||
        (value.key != null && typeof value.key !== 'string') ||
        (value.origin != null && !origins.has(String(value.origin))) ||
        (value.comparison !== undefined && !comparisons.has(String(value.comparison))) ||
        (value.confidence !== undefined &&
          (typeof value.confidence !== 'number' ||
            !Number.isFinite(value.confidence) ||
            value.confidence < 0 ||
            value.confidence > 1))
      ) {
        throw new Error('value');
      }
      const group = ['and', 'or', 'not'].includes(value.op);
      if (value.children !== undefined && !Array.isArray(value.children)) throw new Error('children');
      const children = (value.children ?? []) as unknown[];
      if (
        (group && !children.length) ||
        children.length > 20 ||
        (value.op === 'not' && children.length !== 1) ||
        (!group && children.length)
      ) {
        throw new Error('group');
      }
      for (const child of children) stack.push({ value: child, depth: depth + 1 });
    }
    return { filter: parsed as FilterNode };
  } catch {
    return {
      error: 'Os filtros deste link são inválidos ou excedem os limites. Limpe a busca para continuar.',
    };
  }
}
