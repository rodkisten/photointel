import { spawnSync } from 'node:child_process';

// Check both independent TS projects before returning a combined status.
let failed = false;
for (const config of ['tsconfig.json', 'tsconfig.worker.json']) {
  console.log('\nTypeScript: ' + config);
  const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['--no-install', 'tsc', '-p', config, '--noEmit'],
    { stdio: 'inherit', env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' } });
  if (result.error) console.error(result.error);
  if (result.error || result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
