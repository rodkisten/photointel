import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Search } from 'lucide-react';
import { Button, Input } from './ui';
import { ScrollArea } from './scroll-area';
import { CorrelationPopover, isCorrelationKey } from './correlation-links';

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
  if (value === null) return 'text-carbon-500';
  switch (kind) {
    case 'string':
      return 'text-emerald-400';
    case 'number':
      return 'text-violet-400';
    case 'boolean':
      return 'text-sky-400';
    default:
      return 'text-carbon-300';
  }
}

// ==========================================
// Subcomponentes
// ==========================================

function PlainHighlight({ text, pattern }: { text: string; pattern: RegExp | null }) {
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
          <mark key={index} className="rounded-sm bg-amber-500/40 text-amber-100 inline break-all">
            {part.value}
          </mark>
        ) : (
          <Fragment key={index}>{part.value}</Fragment>
        ),
      )}
    </>
  );
}

/** Link UUIDs only when the log identifies them as correlation IDs. */
function Highlight({
  text,
  pattern,
  correlationKey = false,
}: {
  text: string;
  pattern: RegExp | null;
  correlationKey?: boolean;
}) {
  const uuid = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi;
  const labelled =
    /(?:correlation[_-]?id|correlationId)["']?\s*[:=]\s*["']?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi;
  const matches: Array<{ id: string; start: number; end: number }> = [];
  if (correlationKey) {
    for (const match of text.matchAll(uuid)) {
      matches.push({ id: match[0], start: match.index, end: match.index + match[0].length });
    }
  } else {
    for (const match of text.matchAll(labelled)) {
      const id = match[1];
      const start = match.index + match[0].lastIndexOf(id);
      matches.push({ id, start, end: start + id.length });
    }
  }
  if (!matches.length) return <PlainHighlight text={text} pattern={pattern} />;
  const parts = [];
  let cursor = 0;
  for (const match of matches.slice(0, 40)) {
    if (match.start < cursor) continue;
    if (match.start > cursor) {
      parts.push(
        <PlainHighlight key={'text-' + cursor} text={text.slice(cursor, match.start)} pattern={pattern} />,
      );
    }
    parts.push(<CorrelationPopover key={'id-' + match.start} id={match.id} />);
    cursor = match.end;
  }
  if (cursor < text.length) {
    parts.push(<PlainHighlight key={'tail-' + cursor} text={text.slice(cursor)} pattern={pattern} />);
  }
  return <>{parts}</>;
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
              <span className="text-carbon-500 mr-1">:</span>
            </>
          )}

          {isObject ? (
            <button
              type="button"
              className="font-mono text-carbon-400 hover:text-white transition-colors"
              onClick={() => setManualOpen(!isOpen)}
            >
              {isOpen ? (isArray ? '[' : '{') : summary}
            </button>
          ) : (
            <span className={syntaxTone}>
              <Highlight
                text={primitiveString}
                pattern={pattern}
                correlationKey={Boolean(name && isCorrelationKey(name))}
              />
            </span>
          )}
        </span>
      </div>

      {isObject && isOpen && (
        <div role="group" className="ml-2 border-l border-carbon-700/60 pl-3">
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
            <p className="px-2 py-1 text-xs text-carbon-500 italic">
              Mais {entries.length - 1200} propriedades ocultas. Copie o JSON para inspecionar tudo.
            </p>
          )}

          <div className="pb-1 font-mono text-carbon-500">{isArray ? ']' : '}'}</div>
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
  // Includes the literal string "{}" after asStructuredData() parses it.
  const isEmpty =
    value == null ||
    (typeof value === 'string' && value.trim() === '') ||
    (typeof value === 'object' && Object.keys(value).length === 0);

  const handleCopy = () => {
    const textToCopy = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    navigator.clipboard?.writeText(textToCopy);
  };

  if (isEmpty) return null;

  return (
    <div className="w-full min-w-0 max-w-full overflow-hidden rounded-lg border border-carbon-800 bg-carbon-950">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-carbon-800 bg-carbon-900/50 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-carbon-400">{title}</span>

        {showSearch && externalSearch === undefined && (
          <div className="relative min-w-[120px] flex-1 sm:max-w-64">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-carbon-500"
            />
            <Input
              className="h-7 pl-8 text-sm sm:text-xs bg-carbon-900 border-carbon-700 focus:border-carbon-600"
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
          className="px-2 text-carbon-400 hover:text-carbon-100"
        >
          <Copy size={11} className="mr-1.5" /> Copiar
        </Button>
      </div>

      {/* Content */}
      <ScrollArea className="w-full min-w-0 max-w-full" style={{ maxHeight: Math.min(maxHeight, 500) }}>
        <div
          role={isStructured ? 'tree' : undefined}
          aria-label={title}
          className="w-full min-w-0 max-w-full p-2.5 font-mono text-[12px] leading-5 text-carbon-300"
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
