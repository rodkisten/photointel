import type { FilterNode } from './types';

// --- TYPES & INTERFACES ---

export type GenericObject = Record<string, unknown>;

export interface UrlFilterResult {
  filter?: FilterNode;
  error?: string;
}

// --- CONFIGURATION & CONSTANTS ---

export const FILTER_CONFIG = {
  MAX_RAW_LENGTH: 12_000,
  MAX_DEPTH: 8,
  MAX_NODES: 100,
  MAX_CHILDREN: 20,
  ERROR_MESSAGE: 'Os filtros deste link são inválidos ou excedem os limites. Limpe a busca para continuar.',
} as const;

// Arrays 'as const' automatically generate strict Literal Union Types in TS, 
// and we feed them into Sets for O(1) runtime validation.
const OPERATIONS = [
  'and', 'or', 'not', 'tag', 'text', 'date', 'number', 
  'media_type', 'source', 'album', 'duplicate', 'quality', 'screenshots'
] as const;

const COMPARISONS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const;
const ORIGINS = ['apple', 'joytag', 'user', 'import', 'external'] as const;

const OPERATION_SET = new Set<string>(OPERATIONS);
const COMPARISON_SET = new Set<string>(COMPARISONS);
const ORIGIN_SET = new Set<string>(ORIGINS);

// --- TYPE GUARDS ---

const isRecord = (value: unknown): value is GenericObject => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isScalar = (value: unknown): boolean => {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
};

// --- VALIDATION MODULES ---

function isValidNodePayload(node: GenericObject): boolean {
  if (typeof node.op !== 'string' || !OPERATION_SET.has(node.op)) {
    return false;
  }

  // Value boundaries must be safe scalar types
  if (!isScalar(node.value) || !isScalar(node.minimum) || !isScalar(node.maximum)) {
    return false;
  }

  // String property enums
  if (node.key != null && typeof node.key !== 'string') return false;
  if (node.origin != null && !ORIGIN_SET.has(String(node.origin))) return false;
  if (node.comparison !== undefined && !COMPARISON_SET.has(String(node.comparison))) return false;

  // Strict numeric limits (e.g. AI confidence scores)
  if (node.confidence !== undefined) {
    if (
      typeof node.confidence !== 'number' ||
      !Number.isFinite(node.confidence) ||
      node.confidence < 0 ||
      node.confidence > 1
    ) {
      return false;
    }
  }

  return true;
}

function isValidGroupTopology(op: string, children: unknown[]): boolean {
  const isGroup = op === 'and' || op === 'or' || op === 'not';
  const count = children.length;

  if (count > FILTER_CONFIG.MAX_CHILDREN) return false;
  
  // Logic groups require children to be valid
  if (isGroup && count === 0) return false;
  
  // 'NOT' operator is strictly a unary wrapper
  if (op === 'not' && count !== 1) return false;
  
  // Leaf nodes cannot have nested children
  if (!isGroup && count > 0) return false;

  return true;
}

// --- MAIN EXPORT ---

/** Bound recursive URL data before the editor renders or makes an API request. */
export function readUrlFilter(raw: string | null): UrlFilterResult {
  if (!raw) return {};

  try {
    if (raw.length > FILTER_CONFIG.MAX_RAW_LENGTH) {
      throw new Error('size_exceeded');
    }

    const parsed = JSON.parse(raw) as unknown;
    
    // Stack-based traversal to prevent "Maximum call stack size exceeded" on malicious payloads
    const stack: Array<{ node: unknown; depth: number }> = [{ node: parsed, depth: 0 }];
    let nodeCount = 0;

    while (stack.length > 0) {
      // Safe non-null assertion because of `stack.length > 0` guard
      const { node, depth } = stack.pop()!;
      nodeCount += 1;

      // 1. Guard against DoS via extreme nesting or node flooding
      if (depth > FILTER_CONFIG.MAX_DEPTH || nodeCount > FILTER_CONFIG.MAX_NODES) {
        throw new Error('depth_or_count_exceeded');
      }

      // 2. Validate strict structure
      if (!isRecord(node)) {
        throw new Error('invalid_node_type');
      }

      // 3. Validate node properties and boundaries
      if (!isValidNodePayload(node)) {
        throw new Error('invalid_node_payload');
      }

      // 4. Validate children format and topology constraints
      if (node.children !== undefined && !Array.isArray(node.children)) {
        throw new Error('invalid_children_type');
      }

      const children = (node.children ?? []) as unknown[];

      if (!isValidGroupTopology(node.op as string, children)) {
        throw new Error('invalid_group_topology');
      }

      // 5. Queue children for processing
      for (const child of children) {
        stack.push({ node: child, depth: depth + 1 });
      }
    }

    // If the stack completes without throwing, the AST is 100% structurally safe.
    return { filter: parsed as FilterNode };
  } catch {
    return { error: FILTER_CONFIG.ERROR_MESSAGE };
  }
}
