import assert from 'node:assert/strict';
import test from 'node:test';
import { validateKey, filterGraph } from '../dist/render.js';

test('rejects traversal and malformed keys', () => {
  for (const key of ['../secret', '/absolute', 'a/../b', '', 'a\\b']) {
    assert.throws(() => validateKey(key));
  }
});
test('accepts normal R2 object keys', () => {
  assert.equal(validateKey('originals/clip-01.mp4'), 'originals/clip-01.mp4');
});
test('preserves full frame with letterboxing', () => {
  assert.match(filterGraph(), /force_original_aspect_ratio=decrease/);
  assert.match(filterGraph(), /pad=720:1280/);
});
