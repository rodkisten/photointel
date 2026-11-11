import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDimension, parseFormat, validateKey, transform } from '../dist/render.js';

test('rejects invalid output formats', () => {
  assert.throws(() => parseFormat('svg'));
  assert.equal(parseFormat('avif'), 'avif');
});
test('enforces size and key restrictions', () => {
  assert.throws(() => parseDimension('4097', 100));
  assert.throws(() => parseDimension('NaN', 100));
  assert.throws(() => validateKey('originals/../private.png', 'originals/'));
  assert.throws(() => validateKey('derived/foo.webp', 'originals/'));
  assert.equal(validateKey('derived/abc.webp', 'derived/'), 'derived/abc.webp');
});
test('converts a small image to webp', async () => {
  const sharp = (await import('sharp')).default;
  const input = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).png().toBuffer();
  const result = await transform(input, 'webp', 2, 2);
  assert.equal((await sharp(result).metadata()).format, 'webp');
});
