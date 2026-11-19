import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node parse-wrangler-preview.mjs <output-file>');
  process.exit(2);
}
const output = readFileSync(file, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
const candidates = [];
const collect = (value) => {
  if (typeof value === 'string') candidates.push(value);
  if (Array.isArray(value)) value.forEach(collect);
  if (value && typeof value === 'object') {
    if (Array.isArray(value.urls)) value.urls.forEach(collect);
    if (value.preview) collect(value.preview);
    if (typeof value.url === 'string') collect(value.url);
  }
};
try {
  collect(JSON.parse(output));
} catch {
  // Wrangler sometimes emits human-readable output even with --json.
  for (const match of output.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    candidates.push(match[0].replace(/[),.;]+$/, ''));
  }
}
const url = candidates.find((candidate) => {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' &&
      (parsed.hostname.endsWith('.workers.dev') || parsed.hostname.endsWith('.workers.dev.'));
  } catch {
    return false;
  }
});
if (!url) {
  console.error('::error::Wrangler did not return a valid workers.dev preview URL.');
  console.error(output.slice(-5000));
  process.exit(1);
}
process.stdout.write(url + '\n');
