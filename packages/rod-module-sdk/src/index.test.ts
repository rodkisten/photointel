import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseModuleManifest } from './index.ts';
const sha = 'a'.repeat(40),
  base = 'https://sandbox.migos.club';
const manifest = {
  schemaVersion: 1,
  id: 'sandbox',
  name: 'rod_sandbox',
  version: '0.1.0',
  gitSha: sha,
  contractMajor: 1,
  entry: `${base}/modules/sandbox/${sha}/mf-manifest.json`,
  standaloneUrl: base,
  exposes: ['./App'],
  capabilities: ['browser.build'],
};
test('accepts trusted pinned release', () =>
  assert.equal(parseModuleManifest(manifest, `${base}/rod-module.json`, [base]).gitSha, sha));
for (const patch of [
  { name: undefined },
  { id: undefined },
  { entry: 'https://evil.test/mf-manifest.json' },
  { contractMajor: 2 },
  { gitSha: 'main' },
  { entry: `${base}/modules/sandbox/${'b'.repeat(40)}/mf-manifest.json` },
  { standaloneUrl: 'https://pr12.sandbox.migos.club' },
]) {
  test(`rejects ${JSON.stringify(patch)}`, () =>
    assert.throws(() => parseModuleManifest({ ...manifest, ...patch }, `${base}/rod-module.json`, [base])));
}
