/** v1.1 onboarding against the real local API and persisted PostgreSQL state.
 * No route interception, gate attestation, cloud request or native PhotoKit write.
 * Run with the isolated APP_ENV=test fixture library used by application.spec.ts.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

type Gate = {
  id: string;
  name: string;
  status: string;
  evidence: string[];
  verified_at: string | null;
};
type Gates = { items: Gate[]; full_backfill_unlocked: boolean };
type SetupCheck = { id: string; label: string; state: string; reason: string };
type Setup = {
  checks: SetupCheck[];
  next_action: { href: string; label: string } | null;
  spending: { enabled: boolean };
};
const api = (process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000').replace(/\/$/, '');

async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`${api}${path}`);
  expect(response.ok(), `${path}: ${response.status()}`).toBeTruthy();
  return response.json() as Promise<T>;
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth, width: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.viewport).toBe(370);
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.width);
}

test.beforeAll(async ({ request }) => {
  const settings = await get<{ app_env: string }>(request, '/v1/settings');
  expect(settings.app_env, 'Acceptance tests may only inspect the seeded test system').toBe('test');
  const libraries = await get<{ items: { source_type: string }[] }>(request, '/v1/libraries');
  expect(libraries.items.length).toBeGreaterThan(0);
  expect(libraries.items.every((library) => library.source_type === 'fixture'),
    'No personal iCloud library may be used by browser acceptance tests').toBeTruthy();
});

test('v1.1 setup shows persisted unverified gates without unlocking a real backfill', async ({ page, request }) => {
  const gates = await get<Gates>(request, '/v1/verification/gates');
  expect(gates.full_backfill_unlocked).toBe(false);
  expect(gates.items).toHaveLength(1);
  expect(gates.items.every((gate) => gate.status !== 'passed')).toBeTruthy();
  await page.goto('/setup');
  await expect(page.getByRole('heading', { level: 1, name: 'Preparação e validação' })).toBeVisible();
  const section = page.getByRole('region', { name: 'Autorização para importações grandes', exact: true });
  await expect(section.getByText('Importações de até 1.000 fotos não exigem gates.', { exact: false })).toBeVisible();
  await expect(section.locator('.gate-item')).toHaveCount(gates.items.length);
  for (const gate of gates.items) {
    const item = section.locator('.gate-item').filter({
      has: page.getByRole('heading', { name: gate.name, exact: true }),
    });
    await expect(item).toBeVisible();
    await expect(item.locator(`.status-${gate.status}`)).toBeVisible();
    await expect(item.getByText('Sem verificação registrada', { exact: true })).toBeVisible();
    if (gate.status === 'blocked') {
      await expect(item.getByRole('button', { name: 'Registrar verificação' })).toBeDisabled();
    }
  }
  await expect(page.getByRole('region', { name: 'Release instalada', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  // Merely viewing onboarding cannot attest gates or mutate authorization.
  expect(await get<Gates>(request, '/v1/verification/gates')).toEqual(gates);
});

test('v1.1 overview uses real diagnostics and links to setup at 370px', async ({ page, request }) => {
  const setup = await get<Setup>(request, '/v1/setup/status');
  expect(setup.checks.some((check) => check.id === 'database' && check.state === 'operational'))
    .toBeTruthy();
  const gpu = setup.checks.find((check) => check.id === 'gpu');
  expect(gpu?.state, 'Test fixtures must not claim a real Modal GPU validation').not.toBe('operational');
  await page.setViewportSize({ width: 370, height: 812 });
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Preparação do ambiente', exact: true });
  await expect(panel).toBeVisible();
  for (const check of setup.checks) {
    const row = panel.locator('.row-item').filter({
      has: page.getByText(check.label, { exact: true }),
    });
    await expect(row.locator(`.status-${check.state}`)).toBeVisible();
    await expect(row.getByText(check.reason, { exact: true })).toBeVisible();
  }
  const spending = setup.spending.enabled ? 'Processamento com gasto habilitado.' :
    'Processamento com gasto desabilitado.';
  await expect(panel.getByText(spending, { exact: false })).toBeVisible();
  const setupLink = panel.getByRole('link', { name: 'Ver diagnóstico e release', exact: false });
  await expect(setupLink).toHaveAttribute('href', '/setup');
  if (setup.next_action) {
    await expect(panel.getByRole('link', { name: 'Continuar', exact: false }))
      .toHaveAttribute('href', setup.next_action.href);
  }
  await expectNoHorizontalOverflow(page);
  await setupLink.click();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Preparação e validação' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('v1.1 per-photo recovery shows empty persisted states without destructive controls', async ({ page, request }) => {
  await page.setViewportSize({ width: 370, height: 812 });
  await page.goto('/icloud');
  const section = page.getByRole('region', { name: 'Falhas por fotografia', exact: true });
  await expect(section).toBeVisible();
  for (const status of ['failed', 'retrying', 'quarantined']) {
    const failures = await get<{ items: unknown[] }>(request, `/v1/ingestion/failures?status=${status}&limit=30`);
    expect(failures.items, 'A clean synthetic seed should not contain failed discovery manifests').toEqual([]);
    await section.getByRole('combobox', { name: 'Estado das falhas', exact: true }).selectOption(status);
    await expect(section.getByRole('heading', { name: 'Nenhuma falha neste estado', exact: true })).toBeVisible();
    await expect(section.getByText('Os erros de download e as tentativas ficam preservados por fotografia.', { exact: true }))
      .toBeVisible();
    await expect(section.locator('.failure-row')).toHaveCount(0);
    await expect(section.getByRole('button', { name: /excluir|delete|apagar/i })).toHaveCount(0);
  }
  await expectNoHorizontalOverflow(page);
});

test('v1.1 Bridge runtime reports unverified native writes without enabling modification', async ({ page, request }) => {
  const state = await get<{
    native_write_enabled: boolean; bulk_write_enabled: boolean; cloud_confirmation_available: boolean;
    keyword_write_note: string; devices: { revoked_at: string | null; write_verified: boolean }[];
  }>(request, '/v1/apple-sync/status');
  expect(state.native_write_enabled).toBe(false);
  expect(state.bulk_write_enabled).toBe(false);
  expect(state.cloud_confirmation_available).toBe(false);
  expect(state.devices.filter((device) => !device.revoked_at)
    .every((device) => !device.write_verified)).toBeTruthy();
  await page.goto('/bridge');
  await expect(page.getByRole('heading', { level: 1, name: 'Apple Bridge', exact: true })).toBeVisible();
  await expect(page.getByText(state.keyword_write_note, { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ver prévia segura', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /aplicar.*keyword|sincronizar.*todas|apagar|excluir/i })).toHaveCount(0);
});
