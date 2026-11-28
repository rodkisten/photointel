import fs from 'node:fs';
import path from 'node:path';

const appName = process.argv[2] ?? 'web';
const sdkDir = path.resolve('src/api/hey-api');

if (!fs.existsSync(sdkDir) || !fs.statSync(sdkDir).isDirectory()) {
  console.error(`❌ Diretório não encontrado: ${sdkDir}`);
  process.exit(1);
}

const files = fs
  .readdirSync(sdkDir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.relative(process.cwd(), path.join(entry.parentPath, entry.name)))
  .sort((a, b) => a.localeCompare(b));

if (files.length === 0) {
  console.error(`❌ Nenhum arquivo gerado em ${sdkDir}`);
  process.exit(1);
}

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  const report = [
    `### 🧬 Hey API · ${appName}`,
    ...files.map((file) => `- ${file}`),
  ].join('\n');
  fs.appendFileSync(summaryPath, `${report}\n`, 'utf8');
}
