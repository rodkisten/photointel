import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const dist = resolve(import.meta.dirname, '../dist');

async function collect(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const files = (await collect(dist))
  .filter((path) => !/(?:^|\/)(?:sw\.js|_headers)$/.test(path.replaceAll('\\', '/')) && !/\.map$/.test(path))
  .sort();
const paths = files.map((path) => '/' + relative(dist, path).split(sep).join('/')).sort();
const digest = createHash('sha256');
for (const path of files) {
  digest.update(relative(dist, path));
  digest.update(await readFile(path));
}
const version = digest.digest('hex').slice(0, 20);
const path = join(dist, 'sw.js');
let source = await readFile(path, 'utf8');
const marker = '/*__PHOTOINTEL_MANAGE_PRECACHE__*/ []';
if (!source.includes(marker) || !source.includes('__PHOTOINTEL_MANAGE_SW_VERSION__')) {
  throw new Error('Manage service worker precache markers missing');
}
source = source.replace(marker, JSON.stringify(paths)).replace('__PHOTOINTEL_MANAGE_SW_VERSION__', version);
await writeFile(path, source);
console.info('PhotoIntel Manage offline shell', version, paths.length, 'public assets');
