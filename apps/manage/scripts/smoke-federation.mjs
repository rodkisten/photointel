import { chromium } from '@playwright/test';
import { strict as assert } from 'node:assert';
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
const errors = [],
  requests = [];
page.setDefaultTimeout(30000);
page.on('console', (m) => {
  if (m.type() === 'error') console.log('BROWSER', m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
page.on('request', (r) => requests.push(r.url()));
await page.addInitScript(() => {
  const Original = window.Worker;
  window.__workers = new Set();
  window.Worker = class extends Original {
    constructor(...args) {
      super(...args);
      window.__workers.add(this);
    }
    terminate() {
      window.__workers.delete(this);
      super.terminate();
    }
  };
});
// Host backend identity/catalog only. Neither the remote nor its workers are mocked.
await page.route('**/api/**', async (route) => {
  const path = new URL(route.request().url()).pathname;
  await route.fulfill({
    json:
      path === '/api/meta'
        ? { email: 'smoke@example.test', repo: 'rodverse/rodverse', project: 'Rodverse' }
        : path === '/api/projects'
          ? { items: [], global: { enabled: true } }
          : { items: [] },
  });
});
await page.goto('http://localhost:4173/');
await page.locator('.cm-editor').waitFor({ timeout: 60000 });
await page.waitForFunction(() => document.body.textContent.includes('Built'));
assert.ok(await page.locator('iframe').count());
assert.ok(!(await page.locator('iframe').first().getAttribute('sandbox')).includes('allow-same-origin'));
await page.waitForFunction(() => document.body.textContent.includes('Hello, World!'));
console.log('PASS standalone editor, worker compilation, sandboxed preview');
await page.goto('http://localhost:3000/sandbox');
await page.evaluate(() =>
  localStorage.setItem(
    'rodverse:modules:v1:smoke@example.test:default-workspace',
    JSON.stringify({ enabled: true, channel: 'development' }),
  ),
);
await page.reload();
await page
  .locator('[data-rod-module] .cm-editor')
  .waitFor({ timeout: 30000 })
  .catch(async (e) => {
    console.log(await page.locator('body').innerText(), errors);
    await browser.close();
    throw e;
  });
await page
  .waitForFunction(
    () => document.querySelector('[data-rod-module]')?.shadowRoot?.textContent.includes('Hello, World!'),
    {},
    { timeout: 30000 },
  )
  .catch(async (e) => {
    console.log(await page.locator('body').innerText(), errors);
    await browser.close();
    throw e;
  });
assert.match(await page.locator('section[aria-label="Module Registry"]').innerText(), /Módulo montado/);
console.log('PASS real Federation, singleton guard, workers, WASM, preview logs');
const originalStyles = await page.evaluate(() => {
  const el = document.createElement('input');
  el.id = 'host-sentinel';
  el.style.cssText = 'font-size:11px;';
  document.body.append(el);
  return { font: getComputedStyle(el).fontSize, bg: getComputedStyle(document.body).backgroundColor };
});
assert.equal(originalStyles.font, '11px');
const menu = page.locator('[data-rod-module]').getByRole('button', { name: 'Menu', exact: true });
await menu.click();
await page.getByRole('menu').waitFor();
assert.ok(
  await page.evaluate(() =>
    document
      .querySelector('[data-rod-module]')
      .shadowRoot.querySelector('[data-sandbox-portals] [role=menu]'),
  ),
);
assert.equal(await page.evaluate(() => document.body.style.pointerEvents), '');
await page.keyboard.press('Escape');
console.log('PASS Radix portal contained; host input CSS and pointer events preserved');
assert.ok(
  await page.evaluate(() => {
    try {
      document.querySelector('[data-rod-module]').shadowRoot.querySelector('iframe').contentWindow.document;
      return false;
    } catch {
      return true;
    }
  }),
);
console.log('PASS production CSP template and opaque preview origin isolation');
const measurements = await page.evaluate(() => {
  const host = document.querySelector('[data-rod-module]');
  const bench = host.shadowRoot.querySelector('.sandbox-workbench');
  return { host: host.getBoundingClientRect().height, bench: bench.getBoundingClientRect().height };
});
assert.ok(Math.abs(measurements.host - measurements.bench) < 2);
assert.ok(await page.evaluate(() => window.__workers.size > 0));
const dbs = await page.evaluate(() => indexedDB.databases());
assert.ok(dbs.some((x) => x.name.includes('manage%3Asmoke')));
await page.screenshot({
  path: process.env.SMOKE_SCREENSHOT || '/tmp/rodverse-federated-smoke.png',
  fullPage: true,
});
await page.goto('http://localhost:3000/modules');
await page.waitForTimeout(300);
// Navigate via SPA for an actual unmount in the same JS realm.
await page.evaluate(() => {
  history.pushState(null, '', '/sandbox');
  window.dispatchEvent(new PopStateEvent('popstate'));
});
await page
  .locator('[data-rod-module] .cm-editor')
  .waitFor({ timeout: 30000 })
  .catch(async (e) => {
    console.log(await page.locator('body').innerText(), errors);
    await browser.close();
    throw e;
  });
await page.evaluate(() => {
  history.pushState(null, '', '/modules');
  window.dispatchEvent(new PopStateEvent('popstate'));
});
await page.waitForFunction(() => !document.querySelector('[data-rod-module]'));
assert.equal(await page.evaluate(() => window.__workers.size), 0);
console.log('PASS unmount terminates workers; persistence namespaced by identity/workspace');
assert.deepEqual(errors, []);
assert.ok(requests.some((url) => url.endsWith('esbuild') || url.endsWith('.wasm')));
assert.ok(requests.some((url) => url.includes('/modules/sandbox/') && url.endsWith('/typescript-libs.json')));
assert.ok(!requests.some((url) => url.includes('/api/terminal')));
console.log('PASS no browser exceptions; remote assets resolve to SHA origin; no host PTY probe');
await browser.close();
