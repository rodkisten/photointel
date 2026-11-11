import chalk from 'chalk';
import ora from 'ora';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

type Mode = 'plan' | 'verify' | 'apply';
type Step = { title: string; command: string[]; mutates?: boolean; secret?: boolean };
const project = 'photointel';
const region = 'us-central1';
const names = ['photointel-media-imagor-signing', 'photointel-media-gateway-signing'];
const mode = process.argv[2] as Mode;
const noColor = !stdout.isTTY || Boolean(process.env.NO_COLOR);
if (noColor) chalk.level = 0;

export function renderCommand(args: string[]): string {
  return args.map((arg, i) => {
    const escaped = /^[\w./:@=-]+$/.test(arg) ? arg : JSON.stringify(arg);
    if (i === 0) return chalk.cyan.bold(escaped);
    if (arg.startsWith('--')) return chalk.magenta(escaped);
    if (arg.startsWith('projects/') || arg.startsWith('photointel')) return chalk.green(escaped);
    return chalk.white(escaped);
  }).join(' ');
}
function printCommand(args: string[]): void {
  const line = '─'.repeat(Math.max(1, Math.min(stdout.columns || 80, 160)));
  stdout.write(chalk.dim(line) + '\n' + renderCommand(args) + '\n' + chalk.dim(line) + '\n');
}
function run(args: string[], input?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'], shell: false });
    let errorText = '';
    child.stderr.on('data', chunk => { errorText = (errorText + String(chunk)).slice(-2048); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(errorText.trim() || 'Exit code ' + code)));
    if (input) child.stdin.end(input);
  });
}
async function step(item: Step, index: number, total: number, input?: Buffer): Promise<boolean> {
  stdout.write('\n' + chalk.bold(`[${index}/${total}] ${item.title}`) + '\n');
  printCommand(item.secret ? [...item.command, '<secret supplied through stdin>'] : item.command);
  if (mode === 'plan' && item.mutates) {
    stdout.write(chalk.yellow('○ Planejado: nenhuma alteração executada\n'));
    return true;
  }
  const spinner = ora({ text: 'Executando...', stream: process.stderr, isEnabled: Boolean(process.stderr.isTTY) }).start();
  try {
    await run(item.command, input);
    spinner.succeed('Concluído');
    return true;
  } catch (error) {
    spinner.fail('Falhou: ' + String(error instanceof Error ? error.message : error));
    return false;
  }
}
async function main(): Promise<void> {
  if (!['plan', 'verify', 'apply'].includes(mode)) {
    throw new Error('Use: node dist/cli.js plan|verify|apply');
  }
  stdout.write(chalk.bold.cyan('PhotoIntel Media Engine · Bootstrap\n'));
  stdout.write(`Projeto: ${project} · Região: ${region} · Modo: ${mode}\n`);
  const checks: Step[] = [
    { title: 'Validar CLI GCP', command: ['gcloud', '--version'] },
    { title: 'Verificar projeto selecionado', command: ['gcloud', 'projects', 'describe', project, '--format=value(projectId)'] },
    { title: 'Verificar repositório existente', command: ['gcloud', 'artifacts', 'repositories', 'describe', 'photointel', '--project', project, '--location', region] },
  ];
  let number = 0;
  const total = checks.length + names.length;
  for (const item of checks) {
    if (!await step(item, ++number, total)) throw new Error('Preflight failed; no changes made');
  }
  if (mode === 'apply') {
    if (!stdout.isTTY || !stdin.isTTY) throw new Error('Interactive terminal required for apply');
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question(chalk.yellow('Digite APPLY photointel para criar somente os segredos ausentes: '));
      if (answer !== 'APPLY photointel') throw new Error('Cancelled');
    } finally { rl.close(); }
  }
  for (const name of names) {
    const describe = ['gcloud', 'secrets', 'describe', name, '--project', project];
    if (mode === 'verify') {
      if (!await step({ title: `Verificar segredo ${name}`, command: describe }, ++number, total)) {
        throw new Error(`Missing secret: ${name}`);
      }
      continue;
    }
    if (mode === 'apply') {
      // Never rotate existing secrets implicitly.
      try { await run(describe); stdout.write(chalk.green(`✓ ${name}: já existe; preservado\n`)); number++; continue; }
      catch { /* create below, IAM failures will surface on create */ }
    }
    const create = ['gcloud', 'secrets', 'create', name, '--project', project, '--replication-policy=automatic', '--data-file=-'];
    const input = mode === 'apply' ? Buffer.from(randomBytes(32).toString('hex')) : undefined;
    try {
      if (!await step({ title: `Criar segredo ${name}`, command: create, mutates: true, secret: true }, ++number, total, input)) {
        throw new Error('Creation failed');
      }
    } finally { input?.fill(0); }
  }
  stdout.write(chalk.green.bold('\nEtapas concluídas. Nenhuma operação de billing executada.\n'));
}
main().catch(error => { console.error(chalk.red(String(error))); process.exitCode = 1; });
