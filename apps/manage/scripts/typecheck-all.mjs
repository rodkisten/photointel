import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Run the native TypeScript 7 compiler explicitly. The TypeScript 6 API
// remains installed as 'typescript' for ESLint and compiler-API consumers.
const compiler = fileURLToPath(new URL('../node_modules/@typescript/native/bin/tsc', import.meta.url));
let failed = false;
for (const config of ['tsconfig.json', 'tsconfig.worker.json']) {
  console.log('\nTypeScript 7: ' + config);
  const result = spawnSync(process.execPath, [compiler, '-p', config, '--noEmit'],
    { stdio: 'inherit', env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' } });
  if (result.error) console.error(result.error);
  if (result.error || result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
