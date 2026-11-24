import diagnosticCatalog from '../gcp-diagnostic-catalog.json';
import { useMemo, useState } from 'react';
import { Check, ChevronDown, Copy, ExternalLink, Search } from 'lucide-react';

type Level = 'all' | 'error' | 'warning' | 'success';
const ansi = new RegExp(String.fromCharCode(27) + String.raw`\[[0-9;]*[A-Za-z]`, 'g');
const sensitive = /((?:authorization|token|password|secret|api[_-]?key)\s*[:=]\s*)(?:"[^"]+"|'[^']+'|\S+)/gi;
const classify = (line: string): Exclude<Level, 'all'> | 'normal' => {
  if (/::error::|\b(error|failed|failure|fatal|traceback|permission denied)\b/i.test(line)) return 'error';
  if (/::warning::|\b(warn(?:ing)?|deprecated)\b/i.test(line)) return 'warning';
  if (/\b(success|succeeded|completed|passed|apply complete)\b|✔|✓/i.test(line)) return 'success';
  return 'normal';
};
const guidance = [
  { pattern: /permission.denied|permission denied|iam.serviceaccounts|iam policy|403 forbidden/i, title: 'Revisar permissões IAM', url: 'https://console.cloud.google.com/iam-admin/iam?project=photointel', hint: 'Confirme a identidade do workflow e os papéis exigidos pelo recurso.' },
  { pattern: /secretmanager|secret manager|secret.*not found/i, title: 'Abrir Secret Manager', url: 'https://console.cloud.google.com/security/secret-manager?project=photointel', hint: 'Verifique se o segredo existe, possui versão habilitada e acesso autorizado.' },
  { pattern: /cloud run|run.googleapis.com|revision.*not ready/i, title: 'Inspecionar Cloud Run', url: 'https://console.cloud.google.com/run?project=photointel', hint: 'Confira revisões, logs de inicialização e permissões de invocação.' },
  { pattern: /artifact.registry|artifactregistry|docker push.*denied/i, title: 'Inspecionar Artifact Registry', url: 'https://console.cloud.google.com/artifacts?project=photointel', hint: 'Confira repositório, imagem e permissões de publicação.' },
  { pattern: /terraform.*state|state lock|error acquiring the state lock/i, title: 'Consultar Terraform', url: 'https://developer.hashicorp.com/terraform/cli/commands/force-unlock', hint: 'Inspecione o lock antes de qualquer desbloqueio. Nunca force sem confirmar a execução proprietária.' },
  { pattern: /wrangler|cloudflare.*(error|denied|unauthorized)/i, title: 'Abrir Cloudflare', url: 'https://dash.cloudflare.com/', hint: 'Confira conta, token e permissões do ambiente.' },
  { pattern: /neon.*(error|denied|unauthorized|connection)/i, title: 'Abrir Neon', url: 'https://console.neon.tech/', hint: 'Confira conexão, branch e disponibilidade do banco.' },
] as const;
const tone = { error: 'text-red-300', warning: 'text-amber-300', success: 'text-emerald-300', normal: 'text-carbon-300' };
export function JobLogViewer({ text, truncated }: { text: string; truncated?: boolean }) {
  const [filter, setFilter] = useState<Level>('all');
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const lines = useMemo(() => text.replace(ansi, '').replace(/\r/g, '').split('\n').map((raw, i) => ({
    number: i + 1, text: raw.replace(sensitive, '$1[redacted]'), level: classify(raw),
  })), [text]);
  const visible = useMemo(() => lines.filter(line =>
    (filter === 'all' || line.level === filter) && line.text.toLowerCase().includes(search.toLowerCase())
  ), [lines, filter, search]);
  const firstError = lines.find(line => line.level === 'error');
  const warnings = lines.filter(line => line.level === 'warning').length;
  const failures = lines.filter(line => line.level === 'error').length;
  const successes = lines.filter(line => line.level === 'success').length;
  const links = useMemo(() => {
    const log = lines.map(line => line.text).join('\n').toLowerCase();
    const rules: Array<[keyof typeof diagnosticCatalog, RegExp]> = [
      ['CLOUD_BUILD', /cloudbuild\.builds\.|cloud build.*(?:failed|denied)|gcloud builds submit/],
      ['DOCKER_REGISTRY', /docker (?:push|pull|login).*?(?:denied|unauthorized|failed)|manifest unknown|no basic auth credentials/],
      ['TERRAFORM_GCP', /terraform.*(?:provider|apply|plan).*?(?:failed|error)|error acquiring the state lock/],
      ['AUTHENTICATION', /unauthenticated|invalid_grant|no active account|login required/],
      ['QUOTA', /resource_exhausted|quota exceeded|429 too many requests|rate limit exceeded/],
      ['SECRET_MANAGER', /secretmanager|secret manager/],
      ['ARTIFACT_REGISTRY', /artifactregistry|artifact registry/],
      ['SERVICE_ACCOUNT_NOT_FOUND', /service account.*(?:not found|does not exist)/],
      ['CLOUD_RUN_JOB_IAM', /run\.jobs\.(?:create|update)/],
      ['IAM_DENY', /deny polic(?:y|ies)/],
      ['IAM_CONDITION', /iam condition|condition not satisfied/],
      ['PERMISSION_DENIED', /permission_denied|permission denied|403 forbidden/],
      ['NOT_FOUND', /not_found|not found|404/],
    ];
    const selected = rules.find(([, pattern]) => pattern.test(log));
    if (selected) {
      const entry = diagnosticCatalog[selected[0]];
      return [{ title: entry.title, hint: entry.hint, url: 'https://console.cloud.google.com/' + entry.route + '?project=photointel' }];
    }
    return guidance.filter(item => lines.some(line => item.pattern.test(line.text))).slice(0, 3);
  }, [lines]);
  const [errorIndex, setErrorIndex] = useState(0);
  const errors = visible.filter(line => line.level === 'error');
  const selectedError = errors[errorIndex % Math.max(1, errors.length)];
  return <section className="min-w-0 overflow-hidden rounded-xl border border-carbon-700 bg-carbon-950" aria-label="Logs do job">
    <div className="border-b border-carbon-800 px-3 py-3" aria-label="Diagnóstico estruturado">
      <p className="text-xs font-semibold text-carbon-100">Resumo da execução</p>
      <p className="mt-1 text-xs text-carbon-400">{failures} erros · {warnings} avisos · {successes} sucessos · {lines.length} linhas</p>
      {firstError && <p className="mt-2 break-words text-xs text-red-300">Primeiro erro, linha {firstError.number}: {firstError.text.slice(0, 240)}</p>}
    </div>
    <details open={rawOpen} onToggle={event => setRawOpen(event.currentTarget.open)} className="min-w-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-3 text-xs font-medium text-carbon-200 [&::-webkit-details-marker]:hidden">
        <span>Raw output · {lines.length} linhas</span>
        <ChevronDown size={16} className={rawOpen ? "rotate-180 transition-transform" : "transition-transform"} />
      </summary>
      <div className="flex flex-wrap items-center gap-2 border-y border-carbon-800 p-2">
      <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-carbon-700 px-2">
        <Search size={14} className="shrink-0 text-carbon-400" />
        <input aria-label="Buscar nos logs" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Buscar nos logs" className="min-w-0 w-full bg-transparent py-2 text-xs text-carbon-100 outline-none" />
      </label>
      <button type="button" className="flex items-center gap-1 rounded-md border border-carbon-700 px-2 py-2 text-xs text-carbon-200"
        onClick={() => { void navigator.clipboard.writeText(lines.map(l => l.text).join('\n')).then(() => setCopied(true)).catch(() => setCopied(false)); }}>
        {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copiado' : 'Copiar'}
      </button>
    </div>
    <div className="flex gap-1 overflow-x-auto border-b border-carbon-800 p-2">
      {(['all', 'error', 'warning', 'success'] as const).map(level => <button type="button" key={level}
        aria-pressed={filter === level} onClick={() => setFilter(level)}
        className={'shrink-0 rounded-md px-2.5 py-1.5 text-xs ' + (filter === level ? 'bg-carbon-700 text-white' : 'text-carbon-400')}>
        {({ all: 'Todos', error: 'Erros', warning: 'Avisos', success: 'Sucessos' })[level]}
      </button>)}
    </div>
    {links.length > 0 && <div className="space-y-2 border-b border-carbon-800 px-3 py-3">
      <p className="text-xs font-medium text-carbon-200">Ações externas sugeridas pelos logs</p>
      {links.map(link => <div key={link.url} className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-[11px] text-carbon-400">{link.hint}</p>
        <a href={link.url} target="_blank" rel="noopener noreferrer"
          className="flex shrink-0 items-center gap-1 text-xs text-sky-300 underline underline-offset-2">
          {link.title}<ExternalLink size={12} />
        </a>
      </div>)}
    </div>}
    {errors.length > 0 && <div className="flex items-center justify-between gap-2 border-b border-carbon-800 px-3 py-2 text-xs">
      <span className="text-red-300">Erro {errorIndex % errors.length + 1} de {errors.length} · linha {selectedError?.number}</span>
      <button type="button" className="rounded-md border border-carbon-700 px-2 py-1 text-carbon-200"
        onClick={() => { const next = (errorIndex + 1) % errors.length; setErrorIndex(next); document.getElementById('job-log-line-' + errors[next].number)?.scrollIntoView({ block: 'nearest' }); }}>
        Próximo erro
      </button>
    </div>}
    {truncated && <p className="px-3 py-2 text-xs text-amber-300">Log truncado pela API. Consulte o GitHub para a saída completa.</p>}
    {firstError && filter === 'all' && !search && <button type="button" className="w-full border-b border-carbon-800 px-3 py-2 text-left text-xs text-red-300"
      onClick={() => { setFilter('error'); setSearch(''); }}>Primeiro erro na linha {firstError.number}. Toque para filtrar erros.</button>}
    <div className="max-h-[65dvh] overflow-auto overscroll-contain font-mono text-[11px] leading-5 sm:text-xs" role="log" aria-label="Saída da CLI">
      {visible.map(line => <div id={'job-log-line-' + line.number} key={line.number} className={'flex min-w-max gap-3 px-3 hover:bg-carbon-900/70 ' + tone[line.level]}>
        <span className="w-10 shrink-0 select-none text-right text-carbon-600">{line.number}</span>
        <span className="whitespace-pre">{line.text || ' '}</span>
      </div>)}
      {!visible.length && <p className="p-3 text-xs text-carbon-400">Nenhuma linha corresponde ao filtro.</p>}
    </div>
    <p className="border-t border-carbon-800 px-3 py-2 text-[11px] text-carbon-500">{visible.length} de {lines.length} linhas</p>
    </details>
  </section>;
}
