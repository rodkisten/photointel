import fs from 'node:fs';

interface StepOutcome {
  outcome?: string;
}

const rawSteps = process.env.STEP_RESULTS ?? '{}';
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
const steps = JSON.parse(rawSteps) as Record<string, StepOutcome>;

const failedKeys = Object.entries(steps)
  .filter(([, value]) => value.outcome === 'failure')
  .map(([key]) => key);

for (const key of failedKeys) {
  console.log(`::error title=Etapa falhou::${key}`);
}

const summaryLines = [
  '### Resultado das verificações',
  `Etapas com falha: ${failedKeys.length}`,
  ...(failedKeys.length > 0
    ? failedKeys.map((key) => `- ❌ ${key}`)
    : ['✅ Nenhuma falha registrada.']),
];

if (summaryPath) {
  fs.appendFileSync(summaryPath, `${summaryLines.join('\n')}\n`, 'utf8');
}

if (failedKeys.length > 0) {
  process.exit(1);
}
