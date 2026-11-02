import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const dist = resolve(import.meta.dirname, '../dist');
async function list(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await list(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
const files = (await list(dist)).filter((path) =>
  !/(?:^|\/)(?:sw\.js|_headers)$/.test(path.replaceAll('\\', '/')) &&
  !/\.map$/.test(path)
);
const paths = files.map((path) => '/' + relative(dist, path).split(sep).join('/')).sort();
const fingerprint = createHash('sha256');
for (const path of files.sort()) {
  fingerprint.update(relative(dist, path));
  fingerprint.update(await readFile(path));
}
const version = fingerprint.digest('hex').slice(0, 20);
const workerPath = join(dist, 'sw.js');
let worker = await readFile(workerPath, 'utf8');
if (!worker.includes("/*__PHOTOINTEL_PRECACHE__*/ []") || !worker.includes('__PHOTOINTEL_SW_VERSION__')) {
  throw new Error('Service worker build markers missing; refuse unsafe deployment.');
}
worker = worker
  .replace('/*__PHOTOINTEL_PRECACHE__*/ []', JSON.stringify(paths))
  .replace('__PHOTOINTEL_SW_VERSION__', version);
await writeFile(workerPath, worker);
console.info('PhotoIntel offline release', version, paths.length, 'static assets');
