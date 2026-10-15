/** Real local API + PostgreSQL + private object storage. Model outputs are test-only.
 * Run with APP_ENV=test INFERENCE_BACKEND=test GPU_ENABLED=true and the worker.
 * No request interception or fabricated production responses are used here.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

type Asset = {
  id: string; filename: string; width: number; height: number;
  captured_at: string | null; filesize: number;
  thumbnail_url: string; resources?: { resource_type: string; media_url: string }[];
  tags?: { canonical_key: string; origin: string; user_status: string }[];
};
type SearchResult = {
  items: (Asset & { ranking?: { semantic_similarity?: number } })[];
  explanation: { model_revision?: string; ranking_strategy?: string };
};

const api = (process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000').replace(/\/$/, '');
const strictApi = (process.env.AUTH_REJECTION_API_URL ?? 'http://127.0.0.1:8001')
  .replace(/\/$/, '');
const origin = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173';
let fixtures: Asset[] = [];
let ingestionJob: string | undefined;

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`${api}${path}`, { data, headers: { Origin: origin } });
  expect(response.ok(), `${path}: ${response.status()}`).toBeTruthy();
  return response;
}

async function openFixture(page: Page) {
  await page.goto('/library');
  await page.getByRole('button', { name: fixtures[0].filename, exact: true }).click();
  const viewer = page.getByRole('dialog', { name: fixtures[0].filename, exact: true });
  await expect(viewer).toBeVisible();
  // This control opens the mobile bottom sheet; metadata is always visible on desktop.
  await viewer.getByRole('button', { name: 'Informações', exact: true }).click();
  return viewer;
}

test.beforeAll(async ({ request }) => {
  const settingsResponse = await request.get(`${api}/v1/settings`);
  expect(settingsResponse.ok()).toBeTruthy();
  const settings = await settingsResponse.json();
  expect(settings.app_env, 'E2E must never operate against a private live library').toBe('test');
  expect(settings.inference_backend, 'E2E uses explicit deterministic model fixtures').toBe('test');
  const response = await request.get(`${api}/v1/assets?limit=100`);
  expect(response.ok()).toBeTruthy();
  fixtures = (await response.json()).items;
  expect(fixtures.length, 'Run the documented synthetic seed before Playwright').toBeGreaterThanOrEqual(4);
});

test('01 opens the operating dashboard with persisted system statistics', async ({ page, request }) => {
  const response = await request.get(`${api}/v1/system/statistics`);
  expect(response.ok()).toBeTruthy();
  const stats = await response.json();
  expect(stats.total_assets).toBeGreaterThanOrEqual(fixtures.length);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText('Ambiente local', { exact: true })).toBeVisible();
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});

test('02 browses actual seeded thumbnails through authorized media URLs', async ({ page }) => {
  await page.goto('/library');
  const tile = page.getByRole('button', { name: fixtures[0].filename, exact: true });
  await expect(tile).toBeVisible();
  const image = tile.getByRole('img');
  await expect(image).toHaveAttribute('src', /\/v1\/assets\/.+\/media\/thumbnail_/);
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Grade ampla', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Grade ampla', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
});

test('03 opens details with metadata, provenance and keyboard navigation', async ({ page }) => {
  const viewer = await openFixture(page);
  await expect(viewer.getByText('Dimensões', { exact: true })).toBeVisible();
  await expect(viewer.getByText(`${fixtures[0].width} × ${fixtures[0].height}`, { exact: true }))
    .toBeVisible();
  await expect(viewer.getByRole('heading', { name: 'Inteligência e procedência' })).toBeVisible();
  await viewer.getByRole('button', { name: 'Ampliar fotografia' }).click();
  await expect(viewer.getByRole('button', { name: 'Reduzir zoom' })).toBeVisible();
  await viewer.getByRole('button', { name: 'Ajustar à tela' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('04 searches a seeded import tag using the structured API and filter UI', async ({ page, request }) => {
  const result = await post(request, '/v1/search', {
    filter: { op: 'tag', value: 'landscape', confidence: 0.5, origin: 'import' },
    sort: 'captured_desc', limit: 90,
  });
  const matches: SearchResult = await result.json();
  expect(matches.items.length).toBeGreaterThan(0);
  await page.goto('/search');
  await page.getByRole('button', { name: 'Filtros avançados', exact: true }).click();
  await page.getByLabel('Pesquisar palavra-chave', { exact: true }).fill('landscape');
  await page.getByRole('button', { name: 'Aplicar filtros exatos' }).click();
  await expect(page).toHaveURL(/filter=/);
  await expect(page.getByRole('button', { name: matches.items[0].filename, exact: true })).toBeVisible();
  const filter = JSON.parse(new URL(page.url()).searchParams.get('filter') ?? '{}');
  expect(filter.children[0].children[0].value).toBe('landscape');
});

test('05 performs Portuguese semantic retrieval with the explicit test embedding adapter', async ({ page }) => {
  await page.goto('/search');
  await page.getByLabel('Busca semântica em português').fill('Paisagem com montanhas ao pôr do sol');
  await expect(page.getByRole('button', { name: 'Buscar', exact: true })).toBeEnabled();
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/v1/search') && response.request().method() === 'POST' &&
    response.request().postDataJSON().query === 'Paisagem com montanhas ao pôr do sol');
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  const result: SearchResult = await response.json();
  expect(result.items.length).toBeGreaterThan(0);
  expect(result.explanation.ranking_strategy).toBe('cosine_distance_then_uuid');
  expect(result.explanation.model_revision).toBeTruthy();
  for (const item of result.items) expect(Number.isFinite(item.ranking?.semantic_similarity)).toBe(true);
  await expect(page.getByText('Sua frase é interpretada por embeddings SigLIP 2.', { exact: false }))
    .toBeVisible();
});

test('06 applies date, dimensions, size and nested boolean conditions', async ({ page }) => {
  await page.goto('/search');
  await page.getByRole('button', { name: 'Filtros avançados', exact: true }).click();
  await page.getByLabel('Capturada a partir de', { exact: true }).fill('2019-01-01');
  await page.getByLabel('Capturada até', { exact: true }).fill('2025-12-31');
  await page.getByLabel('Tamanho máximo (MB)', { exact: true }).fill('20');
  await page.getByLabel('Largura mínima (px)', { exact: true }).fill('900');
  await page.getByRole('button', { name: 'Grupo aninhado', exact: true }).click();
  await page.getByLabel('Operador do grupo nível 2').selectOption('not');
  await page.getByLabel('Tipo da regra').nth(1).selectOption('screenshots');
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/v1/search') && response.request().postDataJSON()?.filter);
  await page.getByRole('button', { name: 'Aplicar filtros exatos', exact: true }).click();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  const result: SearchResult = await response.json();
  expect(result.items.length).toBeGreaterThan(0);
  for (const item of result.items) {
    expect(item.width).toBeGreaterThanOrEqual(900);
    expect(item.filesize).toBeLessThanOrEqual(20 * 1024 ** 2);
    expect(item.captured_at).not.toBeNull();
  }
  const filter = JSON.parse(new URL(page.url()).searchParams.get('filter') ?? '{}');
  expect(filter.children).toEqual(expect.arrayContaining([
    expect.objectContaining({ op: 'date', minimum: '2019-01-01', maximum: '2025-12-31' }),
    expect.objectContaining({ op: 'number', key: 'width', value: 900 }),
  ]));
});

test('07 persists a manual keyword with user provenance', async ({ page, request }) => {
  const keyword = `e2e-manual-${Date.now()}`;
  const viewer = await openFixture(page);
  await viewer.getByLabel('Nova palavra-chave manual').fill(keyword);
  await viewer.getByRole('button', { name: 'Salvar palavra-chave', exact: true }).click();
  await expect(viewer.getByText(keyword, { exact: true })).toBeVisible();
  const response = await request.get(`${api}/v1/assets/${fixtures[0].id}`);
  const detail: Asset = await response.json();
  expect(detail.tags).toEqual(expect.arrayContaining([
    expect.objectContaining({ canonical_key: keyword, origin: 'user', user_status: 'approved' }),
  ]));
  await page.reload();
  await page.getByRole('dialog').getByRole('button', { name: 'Informações', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(keyword, { exact: true })).toBeVisible();
});

test('08 creates a persistent album, adds photos and browses its collection', async ({ page, request }) => {
  const name = `Viagem de teste ${Date.now()}`;
  await page.goto('/albums');
  await page.getByRole('button', { name: 'Criar álbum', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Criar álbum', exact: true });
  await dialog.getByLabel('Nome', { exact: true }).fill(name);
  await dialog.getByLabel('Descrição').fill('Coleção de arte sintética para teste.');
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/v1/albums') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Criar álbum', exact: true }).click();
  const created = await (await responsePromise).json();
  await post(request, `/v1/albums/${created.id}/assets`, { asset_ids: [fixtures[0].id] });
  await page.reload();
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: fixtures[0].filename, exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('album')).toBe(created.id);
});

test('09 reviews exact duplicates and quality factors without deletion controls', async ({ page }) => {
  await page.goto('/duplicates');
  await page.getByLabel('Tipo de duplicada', { exact: true }).selectOption('exact');
  const group = page.locator('.duplicate-group').first();
  await expect(group).toBeVisible();
  await expect(group.getByRole('heading', { name: /Cópias exatas/ })).toBeVisible();
  expect(await group.locator('.duplicate-photo').count()).toBeGreaterThanOrEqual(2);
  await expect(group.getByText('Nitidez', { exact: true }).first()).toBeVisible();
  await group.getByRole('button', { name: 'Selecionar grupo' }).click();
  const checked = await group.getByRole('checkbox').evaluateAll((nodes) =>
    nodes.every((node) => (node as HTMLInputElement).checked));
  expect(checked).toBe(true);
  await expect(page.getByRole('button', { name: /excluir|delete|apagar/i })).toHaveCount(0);
});

test('10 starts a bounded fixture ingestion from the mobile administration page', async ({ page }) => {
  await page.goto('/icloud');
  await page.getByLabel('Fonte', { exact: true }).selectOption('fixture');
  await page.getByLabel('Limite desta execução', { exact: false }).fill('4');
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/v1/ingestion/start') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Importar fixtures locais', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(202);
  const result = await response.json();
  ingestionJob = result.job_id;
  expect(ingestionJob).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByText('Importação adicionada à fila.', { exact: false })).toBeVisible();
});

test('11 observes durable ingestion completion and persisted job state', async ({ page, request }) => {
  test.setTimeout(90_000);
  if (!ingestionJob) {
    const created = await post(request, '/v1/ingestion/start', { source: 'fixture', limit: 4 });
    ingestionJob = (await created.json()).job_id;
  }
  await expect.poll(async () => {
    const response = await request.get(`${api}/v1/jobs/${ingestionJob}`);
    expect(response.ok()).toBeTruthy();
    const job = await response.json();
    if (job.status === 'failed') throw new Error(`Fixture ingestion failed: ${job.error_code}`);
    return job.status;
  }, { timeout: 60_000, intervals: [250, 500, 1000] }).toBe('completed');
  await page.goto('/jobs');
  await page.getByLabel('Filtrar jobs por estado').selectOption('completed');
  await expect(page.locator('.job-row').first()).toBeVisible();
  await page.locator('.job-row').first().getByRole('button', { name: 'Inspecionar job' }).click();
  await expect(page.getByRole('dialog', { name: 'Inspeção do job' })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Concluído', { exact: true })).toBeVisible();
});

test('12 enrolls a read-only Bridge and previews an approved mapping without Apple writes', async ({ page, request }) => {
  const code = await (await post(request, '/v1/apple-sync/enrollment', {})).json();
  const name = `Pyto E2E ${Date.now()}`;
  const enrollment = await post(request, '/v1/bridge/enroll', {
    code: code.code, name, capabilities: {
      level: 'read_only', photokit_read: true, keywords_read: true,
      keywords_write: false, authorization: 'authorized', platform: 'test-ios',
      adapter: 'test-readonly', reason: 'Inventário controlado de teste; sem hardware PhotoKit.',
    },
  });
  const { device, credential } = await enrollment.json();
  try {
    const manifestResponse = await request.post(`${api}/v1/bridge/manifest`, {
      headers: { Authorization: `Bearer ${credential}` }, data: {
        items: [{ local_identifier: `test-${fixtures[0].id}`, filename: fixtures[0].filename,
          captured_at: fixtures[0].captured_at, width: fixtures[0].width,
          height: fixtures[0].height, media_type: 'image', keywords: ['palavra existente'] }],
        checkpoint: 'e2e-1', complete: true,
      },
    });
    expect(manifestResponse.ok()).toBeTruthy();
    const inventory = await manifestResponse.json();
    await post(request, '/v1/apple-sync/mappings/confirm', {
      asset_id: fixtures[0].id, snapshot_id: inventory.items[0].snapshot_id, confirm: true,
    });
    await page.goto(`/bridge?asset=${fixtures[0].id}`);
    await page.getByLabel('Dispositivo', { exact: true }).selectOption(device.id);
    await page.getByLabel('Adicionar keywords, separadas por vírgula').fill('viagem aprovada');
    const previewPromise = page.waitForResponse((response) =>
      response.url().endsWith('/v1/apple-sync/preview'));
    await page.getByRole('button', { name: 'Ver prévia segura', exact: true }).click();
    const preview = await (await previewPromise).json();
    expect(preview.write_available).toBe(false);
    expect(preview.capability).toBe('read_only');
    expect(preview.before).toContain('palavra existente');
    expect(preview.add).toContain('viagem aprovada');
    await expect(page.getByText('Indisponível; operação ficará pendente', { exact: true })).toBeVisible();
    const operationPromise = page.waitForResponse((response) =>
      response.url().endsWith('/v1/apple-sync/operations') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Criar operação para aprovação', exact: true }).click();
    const operation = await (await operationPromise).json();
    expect(operation.status).toBe('awaiting_approval');
    await post(request, `/v1/apple-sync/operations/${operation.id}/cancel`, {});
  } finally {
    await post(request, `/v1/apple-sync/devices/${device.id}/revoke`, {});
  }
});

test('13 rejects unauthenticated application and Bridge requests and foreign origins', async ({ request }) => {
  const response = await request.get(`${strictApi}/v1/assets`);
  expect(response.status()).toBe(401);
  const forged = await request.get(`${strictApi}/v1/assets`, {
    headers: { 'Cf-Access-Authenticated-User-Email': 'ci@example.invalid' },
  });
  expect(forged.status()).toBe(401);
  const unauthorizedBridge = await request.get(`${api}/v1/bridge/operations`);
  expect(unauthorizedBridge.status()).toBe(401);
  const crossSite = await request.post(`${api}/v1/albums`, {
    headers: { Origin: 'https://untrusted.example.invalid' }, data: { name: 'Forbidden' },
  });
  expect(crossSite.status()).toBe(403);
});

test('14 protects private media and hides non-existent resources', async ({ request }) => {
  const denied = await request.get(`${strictApi}${fixtures[0].thumbnail_url}`);
  expect(denied.status()).toBe(401);
  expect(denied.headers()['cache-control']).toMatch(/no-store/);
  const missing = await request.get(
    `${api}/v1/assets/00000000-0000-4000-8000-000000000001/media/thumbnail_small`,
  );
  expect(missing.status()).toBe(404);
  expect(missing.headers()['content-type']).toContain('application/json');
  const arbitraryVariant = await request.get(`${api}/v1/assets/${fixtures[0].id}/media/original`);
  expect(arbitraryVariant.status()).toBe(422);
});

test('15 supports a 375px viewport, safe navigation and an installable manifest', async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/library');
  await expect(page.getByRole('navigation', { name: 'Navegação móvel' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.getByRole('button', { name: 'Mais páginas' }).click();
  const menu = page.getByRole('dialog', { name: 'Seu workspace' });
  await menu.getByRole('link', { name: 'Apple Bridge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Apple Bridge', exact: true })).toBeVisible();
  await expect(menu).toHaveCount(0);
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifestHref).toBeTruthy();
  const manifestResponse = await request.get(new URL(manifestHref!, origin).href);
  const manifest = await manifestResponse.json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.length).toBeGreaterThan(0);
});
