/** Genuine browser captures of the procedural seed, guarded against live libraries. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

interface FixtureAsset {
  id: string;
  library_id: string;
  filename: string;
  width: number;
  height: number;
}
interface Library { id: string; source_type: string }

const api = (process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000').replace(/\/$/, '');
const output = fileURLToPath(new URL('../../../../reports/previews/', import.meta.url));
const viewport = { width: 375, height: 812 };

async function syntheticCatalog(request: APIRequestContext): Promise<FixtureAsset[]> {
  const settingsResponse = await request.get(`${api}/v1/settings`);
  expect(settingsResponse.ok()).toBeTruthy();
  const settings = await settingsResponse.json();
  expect(settings.app_env, 'Preview artifacts require the explicit test environment').toBe('test');
  expect(settings.inference_backend, 'Preview artifacts must never invoke paid inference').toBe('test');

  const librariesResponse = await request.get(`${api}/v1/libraries`);
  expect(librariesResponse.ok()).toBeTruthy();
  const libraries: Library[] = (await librariesResponse.json()).items;
  expect(libraries.length, 'Run the bounded procedural seed before preview capture').toBeGreaterThan(0);
  expect(libraries.every((library) => library.source_type === 'fixture'),
    'Abort screenshot capture when any non-fixture library exists').toBe(true);
  const fixtureLibraries = new Set(libraries.map((library) => library.id));

  const response = await request.get(`${api}/v1/assets?limit=100`);
  expect(response.ok()).toBeTruthy();
  const catalog = await response.json();
  const assets: FixtureAsset[] = catalog.items;
  expect(catalog.next_cursor, 'Preview capture is restricted to the bounded seed').toBeNull();
  expect(assets.length).toBeGreaterThanOrEqual(4);
  expect(assets.every((asset) => fixtureLibraries.has(asset.library_id) &&
    /^fixture-\d{3}\.jpg$/.test(asset.filename) && asset.width === 960 && asset.height === 720),
  'Only the documented procedural 960×720 fixture assets may appear in preview artifacts').toBe(true);
  return assets;
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
}

test('captures a genuine synthetic iPhone gallery and accessible detail viewer', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  test.skip(info.project.name !== 'iphone', 'These artifacts represent the primary iPhone viewport');
  const assets = await syntheticCatalog(request);
  await page.setViewportSize(viewport);
  await page.goto('/library');

  const gallery = page.getByLabel('Grade de fotografias', { exact: true });
  await expect(gallery).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Navegação móvel' })).toBeVisible();
  await noHorizontalOverflow(page);
  await gallery.focus();
  await expect(gallery).toBeFocused();

  const first = page.getByRole('button', { name: assets[0].filename, exact: true });
  await expect(first).toHaveAccessibleName(assets[0].filename);
  await expect.poll(() => first.getByRole('img').evaluate(
    (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
  )).toBe(true);
  expect(await gallery.locator('.photo-tile').count()).toBeLessThanOrEqual(150);
  await page.evaluate(() => document.fonts.ready);
  await mkdir(output, { recursive: true });

  async function capture(name: string) {
    const path = join(output, name);
    await page.screenshot({ path, fullPage: false, animations: 'disabled' });
    await info.attach(name, { path, contentType: 'image/png' });
  }

  await capture('iphone-library.png');
  await first.click();
  const viewer = page.getByRole('dialog', { name: assets[0].filename, exact: true });
  await expect(viewer).toBeVisible();
  await expect.poll(() => viewer.locator('.viewer-image img').evaluate(
    (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
  )).toBe(true);
  await noHorizontalOverflow(page);
  await page.keyboard.press('Tab');
  expect(await viewer.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  await capture('iphone-viewer.png');

  await viewer.getByRole('button', { name: 'Informações', exact: true }).click();
  await expect(viewer.getByRole('complementary', { name: 'Informações da fotografia' })).toBeVisible();
  await expect(viewer.getByText('960 × 720', { exact: true })).toBeVisible();
  await expect(viewer.getByLabel('Nova palavra-chave manual', { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await capture('iphone-metadata.png');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await writeFile(join(output, 'manifest.json'), JSON.stringify({
    source: 'playwright_actual_browser_capture', synthetic_only: true,
    app_env: 'test', inference_backend: 'test',
    model_validation: 'Deterministic test adapter; these previews do not verify real AI inference.',
    asset_count: assets.length, fixture_dimensions: [960, 720], viewport,
    project: info.project.name, captured_at: new Date().toISOString(),
    files: ['iphone-library.png', 'iphone-viewer.png', 'iphone-metadata.png'],
  }, null, 2));
});
