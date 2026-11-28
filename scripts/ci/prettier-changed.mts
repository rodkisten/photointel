import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import prettier from 'prettier';

const [baseSha, headSha] = process.argv.slice(2);
const diff = execFileSync(
  'git',
  ['diff', '-U0', '--diff-filter=ACMR', baseSha, headSha],
  { encoding: 'utf8' },
);

// Agrupa ranges de linhas alteradas por arquivo
const fileRanges = new Map<string, Array<{ startLine: number; endLine: number }>>();
let currentFile = '';

for (const line of diff.split('\n')) {
  if (line.startsWith('+++ b/')) {
    currentFile = line.slice(6);
  } else if (line.startsWith('@@ ') && currentFile) {
    const match = line.match(/\+(\d+)(?:,(\d+))?/);
    if (match) {
      const startLine = Number(match[1]);
      const count = match[2] ? Number(match[2]) : 1;
      if (count > 0) {
        const list = fileRanges.get(currentFile) ?? [];
        list.push({ startLine, endLine: startLine + count - 1 });
        fileRanges.set(currentFile, list);
      }
    }
  }
}

let hasUnformatted = false;

for (const [file, ranges] of fileRanges) {
  const info = await prettier.getFileInfo(file, { ignorePath: '.prettierignore' });
  if (info.ignored || !info.inferredParser) continue;

  const source = fs.readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const options = (await prettier.resolveConfig(file)) ?? {};

  // Converte linhas para offsets de caracteres
  const lineOffsets: number[] = [0];
  for (const l of lines) {
    lineOffsets.push(lineOffsets[lineOffsets.length - 1] + l.length + 1);
  }

  let formatted = source;
  for (const { startLine, endLine } of ranges.reverse()) {
    const rangeStart = lineOffsets[startLine - 1] ?? 0;
    const rangeEnd = lineOffsets[endLine] ?? source.length;
    formatted = await prettier.format(formatted, {
      ...options,
      filepath: file,
      rangeStart,
      rangeEnd,
    });
  }

  if (formatted !== source) {
    console.error(`❌ Formatação divergente nas linhas alteradas de: ${file}`);
    hasUnformatted = true;
  }
}

if (hasUnformatted) process.exit(1);
console.log('✅ Todas as linhas alteradas estão formatadas.');
