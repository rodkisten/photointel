import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Search } from 'lucide-react';
import { Button, Input } from './ui';
import { ScrollArea } from './scroll-area';

// ==========================================
// Tipos
// ==========================================

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface NodeProps {
  name?: string;
  value: unknown;
  pattern: RegExp | null;
  query: string;
  depth: number;
  defaultExpandDepth: number;
  path: string;
}

interface JsonViewProps {
  data: unknown;
  search?: string;
  title?: string;
  defaultExpandDepth?: number;
  maxHeight?: number;
  showSearch?: boolean;
}

// ==========================================
// Funções Auxiliares (Lógica e Parse)
// ==========================================

export function makeJsonViewHighlightPattern(input: string): RegExp | null {
  const query = input.trim().slice(0, 128);
  if (!query) return null;
  // Escapa caracteres especiais do RegEx
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'gi');
}

function contains(value: unknown, term: string, depth = 0): boolean {
  if (!term || depth > 18) return false;

  if (value === null || typeof value !== 'object') {
    return String(value).toLowerCase().includes(term);
  }

  if (Array.isArray(value)) {
    return value.slice(0, 1000).some((item) => contains(item, term, depth + 1));
  }

  return Object.entries(value)
    .slice(0, 1000)
    .some(([key, child]) => key.toLowerCase().includes(term) || contains(child, term, depth + 1));
}

export function asStructuredData(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

// Auxiliar para definir a cor baseada no tipo primitivo
function getSyntaxColor(value: unknown, kind: string): string {
  if (value === null) return 'text-slate-500';
  switch (kind) {
    case 'string':
      return 'text-emerald-400';
    case 'number':
      return 'text-violet-400';
    case 'boolean':
      return 'text-sky-400';
    default:
      return 'text-slate-300';
  }
}

// ==========================================
// Subcomponentes
// ==========================================

function Highlight({ text, pattern }: { text: string; pattern: RegExp | null }) {
  if (!pattern) return <>{text}</>;

  const parts: Array<{ value: string; match: boolean }> = [];
  let position = 0;

  for (const match of text.matchAll(pattern)) {
    if (match.index > position) {
      parts.push({ value: text.slice(position, match.index), match: false });
    }
    parts.push({ value: match[0], match: true });
    position = match.index + match[0].length;
    if (parts.length > 200) break; // Limite de segurança de renderização
  }

  if (position < text.length) {
    parts.push({ value: text.slice(position), match: false });
  }

  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} className="rounded-sm bg-amber-500/40 text-amber-100">
            {part.value}
          </mark>
        ) : (
          <Fragment key={index}>{part.value}</Fragment>
        ),
      )}
    </>
  );
}

function Node({ name, value, pattern, query, depth, defaultExpandDepth, path }: NodeProps) {
  const isObject = value !== null && typeof value === 'object';
  const isArray = Array.isArray(value);

  const [manualOpen, setManualOpen] = useState<boolean | null>(null);

  // Decide se começa expandido
  const isOpen = manualOpen ?? (depth < defaultExpandDepth || Boolean(query && contains(value, query)));

  const entries = isObject
    ? isArray
      ? value.map((item, i) => [String(i), item] as const)
      : Object.entries(value as Record<string, unknown>)
    : [];

  const summary = isArray ? `[${entries.length}]` : `{${entries.length}}`;
  const kind = typeof value;

  const primitiveString = value === null ? 'null' : kind === 'string' ? JSON.stringify(value) : String(value);

  const syntaxTone = getSyntaxColor(value, kind);

  return (
    <div role="treeitem" aria-expanded={isObject ? isOpen : undefined} aria-label={path} className="min-w-0">
      <div className="flex min-w-0 items-start gap-1.5 py-0.5 leading-relaxed">
        {isObject ? (
          <button
            type="button"
            aria-label={(isOpen ? 'Recolher ' : 'Expandir ') + path}
            className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-white/10"
            onClick={() => setManualOpen(!isOpen)}
          >
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="block h-4 w-4 shrink-0" />
        )}

        <span className="min-w-0 break-all">
          {name !== undefined && (
            <>
              <span className="text-sky-300">
                <Highlight text={name} pattern={pattern} />
              </span>
              <span className="text-slate-500 mr-1">:</span>
            </>
          )}

          {isObject ? (
            <button
              type="button"
              className="font-mono text-slate-400 hover:text-white transition-colors"
              onClick={() => setManualOpen(!isOpen)}
            >
              {isOpen ? (isArray ? '[' : '{') : summary}
            </button>
          ) : (
            <span className={syntaxTone}>
              <Highlight text={primitiveString} pattern={pattern} />
            </span>
          )}
        </span>
      </div>

      {isObject && isOpen && (
        <div role="group" className="ml-2 border-l border-slate-700/60 pl-3">
          {entries.slice(0, 1200).map(([key, child]) => (
            <Node
              key={key}
              name={isArray ? undefined : key} // Arrays limpam o index visualmente caso não queira mostrar, mas mantive a chave. Para omitir index: name={isArray ? undefined : key}
              value={child}
              pattern={pattern}
              query={query}
              depth={depth + 1}
              defaultExpandDepth={defaultExpandDepth}
              path={`${path}.${key}`}
            />
          ))}

          {entries.length > 1200 && (
            <p className="px-2 py-1 text-xs text-slate-500 italic">
              Mais {entries.length - 1200} propriedades ocultas. Copie o JSON para inspecionar tudo.
            </p>
          )}

          <div className="pb-1 font-mono text-slate-500">{isArray ? ']' : '}'}</div>
        </div>
      )}
    </div>
  );
}

// ==========================================
// Componente Principal
// ==========================================

export function JsonView({
  data,
  search: externalSearch,
  title = 'JSON',
  defaultExpandDepth = 1,
  maxHeight = 440,
  showSearch = true,
}: JsonViewProps) {
  const [localSearch, setLocalSearch] = useState('');

  const query = (externalSearch ?? localSearch).trim().toLowerCase();
  const pattern = useMemo(() => makeJsonViewHighlightPattern(query), [query]);
  const value = useMemo(() => asStructuredData(data), [data]);

  const isStructured = value !== null && typeof value === 'object';

  const handleCopy = () => {
    const textToCopy = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    navigator.clipboard?.writeText(textToCopy);
  };

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 bg-slate-900/50 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-400">{title}</span>

        {showSearch && externalSearch === undefined && (
          <div className="relative min-w-[120px] flex-1 sm:max-w-64">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500"
            />
            <Input
              className="h-7 pl-8 text-sm sm:text-xs bg-slate-900 border-slate-700 focus:border-slate-600"
              aria-label={`Buscar em ${title}`}
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              placeholder="Buscar e destacar..."
            />
          </div>
        )}

        <Button
          type="button"
          variant="ghost"
          size="xsm"
          onClick={handleCopy}
          title="Copiar conteúdo"
          className="h-7 px-2 text-slate-400 hover:text-slate-100"
        >
          <Copy size={13} className="mr-1.5" /> Copiar
        </Button>
      </div>

      {/* Content */}
      <ScrollArea className="w-full" style={{ height: Math.min(maxHeight, 760) }}>
        <div
          role={isStructured ? 'tree' : undefined}
          aria-label={title}
          className="min-w-0 p-3 font-mono text-[13px] text-slate-300"
        >
          {isStructured ? (
            <Node
              value={value}
              pattern={pattern}
              query={query}
              depth={0}
              defaultExpandDepth={defaultExpandDepth}
              path={title}
            />
          ) : (
            <pre className="whitespace-pre-wrap break-all leading-relaxed">
              <Highlight text={typeof value === 'string' ? value : String(value)} pattern={pattern} />
            </pre>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
