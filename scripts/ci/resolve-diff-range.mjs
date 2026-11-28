import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const ZERO_SHA = '0000000000000000000000000000000000000000';
const rawBase = process.env.RAW_BASE_SHA?.trim() ?? '';
const headSha = process.env.HEAD_SHA?.trim() ?? 'HEAD';
const githubOutput = process.env.GITHUB_OUTPUT;

function canResolve(rev: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', rev], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function writeOutputs(outputs: Record<string, string>): void {
  if (!githubOutput) return;
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${v}`);
  fs.appendFileSync(githubOutput, `${lines.join('\n')}\n`, 'utf8');
}

let baseSha = rawBase;
let skip = false;

if (!baseSha || baseSha === ZERO_SHA) {
  const parentRev = `${headSha}~1`;
  if (canResolve(parentRev)) {
    baseSha = execFileSync('git', ['rev-parse', parentRev], { encoding: 'utf8' }).trim();
  } else {
    console.log('ℹ️ Commit inicial sem ancestral; pulando diff check.');
    skip = true;
  }
}

writeOutputs({
  base_sha: baseSha,
  head_sha: headSha,
  skip: String(skip),
});
