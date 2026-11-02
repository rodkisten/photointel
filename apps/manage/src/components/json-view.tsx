import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Search } from 'lucide-react';
import { Button, Input } from './ui';
import { ScrollArea } from './scroll-area';

type Atom = string | number | boolean | null;
export type JsonValue = Atom | JsonValue[] | { [key: string]: JsonValue };

export function makeJsonViewHighlightPattern(input: string): RegExp | null {
  const query = input.trim().slice(0, 128);
  if (!query) return null;
  return new RegExp(query.split('').map(char => '\\.^$*+?()[]{}|'.includes(char) ? '\\' + char : char).join(''), 'gi');
}
function Highlight({ text, pattern }: { text: string; pattern: RegExp | null }) {
  if (!pattern) return <>{text}</>;
  const parts: Array<{ value: string; match: boolean }> = [];
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > position) parts.push({ value: text.slice(position, match.index), match: false });
    parts.push({ value: match[0], match: true });
    position = match.index + match[0].length;
    if (parts.length > 200) break;
  }
  if (position < text.length) parts.push({ value: text.slice(position), match: false });
  return <>{parts.map((part, index) => part.match
    ? <mark key={index} className="rounded-sm bg-amber-300/35 text-amber-100">{part.value}</mark>
    : <Fragment key={index}>{part.value}</Fragment>)}</>;
}
function contains(value: unknown, term: string, depth = 0): boolean {
  if (!term || depth > 18) return false;
  if (value === null || typeof value !== 'object') return String(value).toLowerCase().includes(term);
  if (Array.isArray(value)) return value.slice(0, 1000).some(item => contains(item, term, depth + 1));
  return Object.entries(value).slice(0, 1000).some(([key, child]) =>
    key.toLowerCase().includes(term) || contains(child, term, depth + 1));
}
function Node({ name, value, pattern, query, depth, defaultExpandDepth, path }: {
  name?: string; value: unknown; pattern: RegExp | null; query: string;
  depth: number; defaultExpandDepth: number; path: string;
}) {
  const expandable = value !== null && typeof value === 'object';
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? (depth < defaultExpandDepth || Boolean(query && contains(value, query)));
  const entries = expandable
    ? Array.isArray(value) ? value.map((item, i) => [String(i), item] as const)
      : Object.entries(value as Record<string, unknown>)
    : [];
  const summary = Array.isArray(value) ? '[' + entries.length + ']' : '{' + entries.length + '}';
  const kind = typeof value;
  const primitive = value === null ? 'null' : kind === 'string' ? JSON.stringify(value) : String(value);
  const tone = value === null ? 'text-slate-500' : kind === 'string'
    ? 'text-emerald-300' : kind === 'number' ? 'text-violet-300'
      : kind === 'boolean' ? 'text-sky-300' : 'text-slate-300';
  return (
    <div role="treeitem" aria-expanded={expandable ? open : undefined} aria-label={path} className="min-w-0">
      <div className="flex min-w-0 items-start gap-1.5 py-[3px] leading-[1.65]">
        {expandable ? (
          <button type="button" aria-label={(open ? 'Recolher ' : 'Expandir ') + path}
            className="mt-[3px] flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-white/10"
            onClick={() => setManual(!open)}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : <span className="block h-5 w-5 shrink-0" />}
        <span className="min-w-0 break-all">
          {name !== undefined && (
            <><span className="text-sky-200"><Highlight text={name} pattern={pattern}/></span>
              <span className="text-slate-500">: </span></>
          )}
          {expandable ? (
            <button type="button" className="font-mono text-slate-400 hover:text-white"
              onClick={() => setManual(!open)}>
              {open ? (Array.isArray(value) ? '[' : '{') : summary}
            </button>
          ) : <span className={tone}><Highlight text={primitive} pattern={pattern}/></span>}
        </span>
      </div>
      {expandable && open && (
        <div role="group" className="ml-[10px] border-l border-[#35373d] pl-[9px]">
          {entries.slice(0, 1200).map(([key, child]) => (
            <Node key={key} name={key} value={child} pattern={pattern} query={query}
              depth={depth + 1} defaultExpandDepth={defaultExpandDepth} path={path + '.' + key}/>
          ))}
          {entries.length > 1200 &&
            <p className="px-4 text-xs text-slate-500">Mais {entries.length - 1200} propriedades. Copie o JSON para inspecionar tudo.</p>}
          <div className="pb-1 font-mono text-slate-500">{Array.isArray(value) ? ']' : '}'}</div>
        </div>
      )}
    </div>
  );
}
export function asStructuredData(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}
export function JsonView({ data, search: externalSearch, title = 'JSON', defaultExpandDepth = 1, maxHeight = 440, showSearch = true }: {
  data: unknown; search?: string; title?: string; defaultExpandDepth?: number;
  maxHeight?: number; showSearch?: boolean;
}) {
  const [localSearch, setLocalSearch] = useState('');
  const query = (externalSearch ?? localSearch).trim().toLowerCase();
  const pattern = useMemo(() => makeJsonViewHighlightPattern(query), [query]);
  const value = useMemo(() => asStructuredData(data), [data]);
  const structured = value !== null && typeof value === 'object';
  const copy = () => void navigator.clipboard?.writeText(
    typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-[#303238] bg-[#101113]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#303238] px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-400">{title}</span>
        {showSearch && externalSearch === undefined &&
          <div className="relative min-w-[110px] flex-1 sm:max-w-60">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-2.5 text-slate-500"/>
            <Input className="h-8 pl-8 text-base sm:text-xs" aria-label={'Buscar em ' + title}
              value={localSearch} onChange={event => setLocalSearch(event.target.value)}
              placeholder="Buscar e destacar"/>
          </div>}
        <Button type="button" variant="ghost" size="xsm" onClick={copy} title="Copiar conteúdo">
          <Copy size={11}/> Copiar
        </Button>
      </div>
      <ScrollArea className="w-full" style={{ height: Math.min(maxHeight, 760) }}>
        <div role={structured ? 'tree' : undefined} aria-label={title}
          className="min-w-0 p-3 font-mono text-xs text-slate-200 sm:text-[13px]">
          {structured
            ? <Node value={value} pattern={pattern} query={query}
                depth={0} defaultExpandDepth={defaultExpandDepth} path={title}/>
            : <pre className="whitespace-pre-wrap break-all leading-[1.7]">
                <Highlight text={typeof value === 'string' ? value : String(value)} pattern={pattern}/>
              </pre>}
        </div>
      </ScrollArea>
    </div>
  );
}
