import { ApiError, json } from './auth';
import type { Env, Identity } from './auth';
import { estimateWorkflowJobs } from './cost-model';
import { gcp, gh, provider } from './providers';

type DataItem = Record<string, unknown>;
type Source = {
  status: 'ok' | 'unconfigured' | 'unavailable';
  currency: string;
  total: number | null;
  gross_total?: number | null;
  items: Array<{ name: string; cost: number | null; detail?: string; units?: number | null; gross?: number | null; credits?: number | null; resource?: string; day?: string; usage_unit?: string; usage_amount?: number | null }>;
  note?: string;
  url?: string;
  quota?: { used_usd: number; included_usd: number | null; percent: number | null; unit: string };
};
const unavailable = (note: string, status: Source['status'] = 'unavailable'): Source => ({
  status, currency: 'USD', total: null, items: [], note,
});
const asNumber = (value: unknown): number | null => {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
};
const round = (value: number): number => Number(value.toFixed(6));
const message = (error: unknown): string => error instanceof ApiError ? error.message : 'Consulta ao provedor falhou.';
const isSource = (value: PromiseSettledResult<Source>): Source =>
  value.status === 'fulfilled' ? value.value : unavailable(message(value.reason));

function monthWindow(month: string) {
  if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(month)) throw new ApiError(422, 'COST_MONTH', 'Mês inválido');
  const start = new Date(month + '-01T00:00:00.000Z');
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  if (start.valueOf() > Date.now()) throw new ApiError(422, 'COST_FUTURE', 'O mês ainda não começou');
  return { month, start: start.toISOString(), end: end.toISOString() };
}

async function githubCosts(env: Env, month: string): Promise<Source> {
  const repo = env.GITHUB_REPO || 'rodkisten/photointel';
  const owner = env.GITHUB_BILLING_OWNER || repo.split('/')[0];
  const scope = env.GITHUB_BILLING_SCOPE || 'users';
  if (!/^[\w-]{1,39}$/.test(owner) || !['users', 'organizations'].includes(scope))
    return unavailable('Conta de billing do GitHub inválida.', 'unconfigured');
  if (!env.GITHUB_API_TOKEN) return unavailable('Token do GitHub ausente.', 'unconfigured');
  const [year, m] = month.split('-');
  const endpoint = 'https://api.github.com/' + scope + '/' + owner +
    '/settings/billing/usage/summary?year=' + year + '&month=' + Number(m);
  const headers = { 'X-GitHub-Api-Version': '2026-03-10' };
  const [repoResult, accountResult] = await Promise.allSettled([
    provider(endpoint + '&repository=' + encodeURIComponent(repo), env.GITHUB_API_TOKEN, { headers }),
    provider(endpoint, env.GITHUB_API_TOKEN, { headers }),
  ]);
  if (repoResult.status === 'rejected') throw repoResult.reason;
  const data = repoResult.value as { usageItems?: Array<Record<string, unknown>> };
  if (!Array.isArray(data.usageItems)) return unavailable('GitHub não retornou usageItems.');
  const actions = data.usageItems.filter((x) => String(x.product || '').toLowerCase() === 'actions');
  if (!actions.length)
    return unavailable('O endpoint de billing não trouxe uso do Actions para este repositório. Não é possível afirmar que o custo foi zero.');
  const gross = round(actions.reduce((sum, x) => sum + (asNumber(x.grossAmount) || 0), 0));
  const net = round(actions.reduce((sum, x) => sum + (asNumber(x.netAmount) || 0), 0));
  const credit = asNumber(env.GITHUB_ACTIONS_INCLUDED_USD);
  const included = credit !== null && credit >= 0 ? credit : null;
  const account = accountResult.status === 'fulfilled'
    ? accountResult.value as { usageItems?: Array<Record<string, unknown>> }
    : null;
  const accountActions = account?.usageItems?.filter((x) => String(x.product || '').toLowerCase() === 'actions');
  const accountGross = accountActions && accountActions.length
    ? round(accountActions.reduce((sum, x) => sum + (asNumber(x.grossAmount) || 0), 0))
    : null;
  return {
    status: 'ok', currency: 'USD', total: net, gross_total: gross,
    quota: accountGross === null ? undefined : {
      used_usd: accountGross,
      included_usd: included,
      percent: included && included > 0 ? round(accountGross / included * 100) : null,
      unit: 'USD em compute da conta',
    },
    items: actions.map((x) => ({
      name: String(x.sku || 'Actions'),
      detail: String(x.unitType || ''),
      cost: asNumber(x.netAmount),
      units: asNumber(x.grossQuantity),
    })),
    url: 'https://github.com/settings/billing',
    note: 'Custo oficial restrito ao repositório; cota baseada no consumo bruto da conta inteira, quando permitido. A cota é configurável e não é a fatura por workflow.',
  };
}

async function gcpCosts(env: Env, identity: Identity, start: string, end: string): Promise<Source> {
  const table = env.GCP_BILLING_TABLE || '';
  if (!table) return unavailable('Configure GCP_BILLING_TABLE e a exportação de billing para BigQuery.', 'unconfigured');
  if (!/^[a-z][a-z0-9-]{4,62}\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.gcp_billing_export_(?:resource_)?v1_[A-Za-z0-9_]+$/.test(table))
    return unavailable('GCP_BILLING_TABLE inválida.', 'unconfigured');
  const billingProject = table.split('.')[0];
  const detailed = table.includes('.gcp_billing_export_resource_v1_');
  // Resource identifiers exist only in the detailed billing export. Do not invent attribution.
  const resourceSql = detailed ? "COALESCE(resource.name, resource.global_name, '(sem recurso)')" : "'(exportação padrão: recurso indisponível)'";
  const query = `SELECT service.description AS service, sku.description AS sku, currency,
    ${resourceSql} AS resource_name,
    FORMAT_TIMESTAMP('%Y-%m-%d', usage_start_time, 'America/Sao_Paulo') AS usage_day,
    usage.unit AS usage_unit,
    ROUND(SUM(usage.amount), 6) AS usage_amount,
    ROUND(SUM(cost), 6) AS gross,
    ROUND(SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)), 6) AS credits,
    ROUND(SUM(cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)), 6) AS net
    FROM \`${table}\`
    WHERE project.id = @project
      AND usage_start_time >= TIMESTAMP(@start)
      AND usage_start_time < TIMESTAMP(@end)
    GROUP BY 1,2,3,4,5,6
    ORDER BY usage_day DESC, net DESC LIMIT 5001`;
  const data = await gcp(env, identity,
    'https://bigquery.googleapis.com/bigquery/v2/projects/' + billingProject + '/queries', {
      query, useLegacySql: false, timeoutMs: 10000, maximumBytesBilled: '100000000',
      parameterMode: 'NAMED',
      queryParameters: [
        { name: 'project', parameterType: { type: 'STRING' }, parameterValue: { value: env.GCP_PROJECT_ID || 'photointel' } },
        { name: 'start', parameterType: { type: 'STRING' }, parameterValue: { value: start } },
        { name: 'end', parameterType: { type: 'STRING' }, parameterValue: { value: end } },
      ],
    },
  ) as { jobComplete?: boolean; totalRows?: string; pageToken?: string; rows?: Array<{ f?: Array<{ v?: unknown }> }> };
  if (data.jobComplete !== true) return unavailable('Consulta ainda em execução. Tente novamente; nenhum custo foi presumido como zero.');
  if ((data.rows || []).length > 5000 || data.pageToken || Number(data.totalRows || 0) > (data.rows || []).length)
    return unavailable('Mais de 5.000 lançamentos ou resultado paginado: o total seria incompleto. Consulte um período menor antes de confiar na soma.');
  const rows = (data.rows || []).map((x) => x.f?.map((v) => v.v) || []);
  const currencies = [...new Set(rows.map((x) => String(x[2] || 'USD')))];
  if (currencies.length > 1) return unavailable('Exportação contém múltiplas moedas. Separe os valores por moeda.');
  const items = rows.map((x) => ({
    name: String(x[0] || 'GCP'),
    detail: String(x[1] || ''),
    resource: String(x[3] || ''),
    day: String(x[4] || ''),
    usage_unit: String(x[5] || ''),
    usage_amount: asNumber(x[6]),
    units: asNumber(x[6]),
    gross: asNumber(x[7]),
    credits: asNumber(x[8]),
    cost: asNumber(x[9]),
  }));
  return {
    status: 'ok', currency: currencies[0] || 'USD',
    total: round(items.reduce((sum, x) => sum + (x.cost || 0), 0)),
    gross_total: round(items.reduce((sum, x) => sum + (x.gross || 0), 0)),
    items,
    url: 'https://console.cloud.google.com/billing?project=' + encodeURIComponent(env.GCP_PROJECT_ID || 'photointel'),
    note: detailed
      ? 'Valores faturados exportados por serviço, SKU, recurso, dia, unidade, consumo e créditos. Não são tempo real; podem chegar com atraso.'
      : 'Exportação padrão: custos reais por serviço, SKU, dia, unidade, consumo e créditos. Ative a exportação detalhada para atribuição por recurso. Dados podem atrasar.',
  };
}

async function cloudflareCosts(env: Env, start: string, end: string): Promise<Source> {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID)
    return unavailable('Token ou account ID do Cloudflare ausente.', 'unconfigured');
  const gql = `query WorkerUsage($account: string!, $start: Time!, $end: Time!) {
    viewer { accounts(filter: { accountTag: $account }) {
      workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }) {
        dimensions { scriptName }
        sum { requests }
      }
    } }
  }`;
  const result = await provider('https://api.cloudflare.com/client/v4/graphql', env.CLOUDFLARE_API_TOKEN, {
    method: 'POST',
    body: JSON.stringify({
      query: gql,
      variables: { account: env.CLOUDFLARE_ACCOUNT_ID, start, end },
    }),
  }) as {
    errors?: unknown[];
    data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{
      dimensions?: { scriptName?: string }; sum?: { requests?: number };
    }> }> } };
  };
  if (result.errors?.length) return unavailable('Cloudflare Analytics não autorizou a consulta. Confira Account Analytics Read.');
  const groups = result.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
  if (!Array.isArray(groups)) return unavailable('Cloudflare não retornou uso de Workers.');
  const buckets = new Map<string, number>();
  for (const item of groups) {
    const name = item.dimensions?.scriptName || 'Worker sem nome';
    buckets.set(name, (buckets.get(name) || 0) + (asNumber(item.sum?.requests) || 0));
  }
  return {
    status: 'ok', currency: 'USD', total: null,
    items: Array.from(buckets).map(([name, units]) => ({
      name, units, cost: round(units * 0.30 / 1_000_000),
      detail: 'Apenas custo marginal estimado por requests, antes da franquia e sem CPU.',
    })),
    url: 'https://dash.cloudflare.com/?to=/:account/workers-and-pages',
    note: 'Estimativa marginal de US$0,30/milhão de requests por Worker, não é o valor cobrado. Franquia, CPU, outros produtos e plano são compartilhados; custo faturado por script indisponível.',
  };
}

async function modalCosts(env: Env, month: string): Promise<Source> {
  if (!env.MODAL_BILLING_URL || !env.MODAL_BILLING_TOKEN)
    return unavailable('Implante o endpoint Modal de billing e configure URL e token no Manage.', 'unconfigured');
  let endpoint: URL;
  try { endpoint = new URL(env.MODAL_BILLING_URL); }
  catch { return unavailable('URL do Modal inválida.', 'unconfigured'); }
  if (endpoint.protocol !== 'https:' || !/^[a-z0-9-]+\.modal\.run$/.test(endpoint.hostname) ||
      endpoint.username || endpoint.password)
    return unavailable('O endpoint Modal deve usar HTTPS num domínio modal.run.', 'unconfigured');
  endpoint.search = '?month=' + encodeURIComponent(month);
  const result = await provider(endpoint.href, env.MODAL_BILLING_TOKEN) as {
    billed_total?: unknown; metered_total?: unknown; items?: Array<{ name?: unknown; cost?: unknown; detail?: unknown }>;
    currency?: unknown; note?: unknown;
  };
  const billed = asNumber(result.billed_total);
  if (billed === null) return unavailable('Endpoint Modal não retornou billed_total válido.');
  return {
    status: 'ok', currency: result.currency === 'USD' ? 'USD' : 'USD', total: billed,
    gross_total: asNumber(result.metered_total),
    items: Array.isArray(result.items) ? result.items.slice(0, 500).map((x) => ({
      name: String(x.name || 'Modal'), detail: String(x.detail || ''), cost: asNumber(x.cost),
    })) : [],
    note: 'Modal Workspace billing summary: custo faturado com ajustes; detalhamento bruto pode não incluir créditos.',
    url: 'https://modal.com/settings',
  };
}

const runCache = new Map<number, { expires: number; value: ReturnType<typeof estimateWorkflowJobs> }>();
async function runCost(env: Env, id: number) {
  const cached = runCache.get(id);
  if (cached && cached.expires > Date.now()) return cached.value;
  const data = await gh(env, '/actions/runs/' + id + '/jobs?per_page=100') as {
    total_count?: number; jobs?: Array<{
      id: number; name: string; labels?: string[]; started_at?: string; completed_at?: string; status?: string;
    }>;
  };
  const jobs = data.jobs || [];
  const result = estimateWorkflowJobs(jobs);
  // If jobs were truncated, do not claim a complete cost.
  if ((data.total_count || 0) > jobs.length) result.incomplete = true;
  if (runCache.size > 250) runCache.clear();
  runCache.set(id, { value: result, expires: Date.now() + (jobs.some((x) => !x.completed_at) ? 30000 : 600000) });
  return result;
}

export async function costRoute(request: Request, env: Env, identity: Identity): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method !== 'GET') return null;
  if (path === '/api/costs/runs') {
    const raw = url.searchParams.get('ids') || '';
    if (!/^\d{1,16}(,\d{1,16}){0,39}$/.test(raw))
      throw new ApiError(422, 'RUN_IDS', 'Informe até 40 execuções válidas');
    const ids = [...new Set(raw.split(',').map(Number))];
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
      throw new ApiError(422, 'RUN_IDS', 'IDs inválidos');
    const items: Record<string, ReturnType<typeof estimateWorkflowJobs> | { error: string }> = {};
    for (let offset = 0; offset < ids.length; offset += 8) {
      const batch = await Promise.allSettled(ids.slice(offset, offset + 8).map((id) => runCost(env, id)));
      batch.forEach((outcome, index) => {
        const id = ids[offset + index];
        items[String(id)] = outcome.status === 'fulfilled' ? outcome.value : { error: message(outcome.reason) };
      });
    }
    return json({ items, basis: 'Preço bruto estimado por runner. Não inclui cota, descontos ou jobs externos.' });
  }
  if (path !== '/api/costs' && path !== '/api/costs/github') return null;
  const month = monthWindow(url.searchParams.get('month') || new Date().toISOString().slice(0, 7));
  if (path === '/api/costs/github') {
    const source = await githubCosts(env, month.month).then((x) => x, (error) => unavailable(message(error)));
    return json({ month: month.month, source });
  }
  const result = await Promise.allSettled([
    githubCosts(env, month.month),
    gcpCosts(env, identity, month.start, month.end),
    cloudflareCosts(env, month.start, month.end),
    modalCosts(env, month.month),
  ]);
  const providers: Record<string, Source> = {
    github: isSource(result[0]), gcp: isSource(result[1]),
    cloudflare: isSource(result[2]), modal: isSource(result[3]),
  };
  const billed = [providers.github, providers.gcp, providers.modal];
  const known = billed.filter((x) => x.status === 'ok' && x.total !== null && x.currency === 'USD');
  return json({
    month: month.month, checked_at: new Date().toISOString(),
    providers, total_usd: known.length ? round(known.reduce((sum, x) => sum + (x.total || 0), 0)) : null,
    complete: known.length === billed.length && providers.cloudflare.status === 'ok' &&
      providers.cloudflare.total !== null,
    note: 'Total parcial: Cloudflare Workers não possui custo faturado por script nesta API. Outras fontes podem faltar.',
  });
}
