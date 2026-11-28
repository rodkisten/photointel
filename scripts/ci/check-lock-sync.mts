import fs from 'node:fs';
import path from 'node:path';

const appDir = process.argv[2] ?? 'apps/web';
const pkgPath = path.join(appDir, 'package.json');
const lockPath = path.join(appDir, 'package-lock.json');

if (!fs.existsSync(lockPath)) {
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const lockFile = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const rootLock = lockFile.packages?.[''];

if (!rootLock?.dependencies) {
  process.exit(1);
}

const sortEntries = (record: Record<string, string> | undefined): string =>
  JSON.stringify(Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b)));

const depKinds = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

for (const kind of depKinds) {
  if (sortEntries(manifest[kind]) !== sortEntries(rootLock[kind])) {
    process.exit(1);
  }
}
