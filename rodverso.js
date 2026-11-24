#!/usr/bin/env node
/**
 * Rodverso Migration Engine
 * Motor single-file conservador (fail-closed) para consolidar repositórios em um monorepo.
 *
 * Requisitos:
 *   - Node.js >= 22, git, gh CLI autenticado (ou GH_TOKEN)
 *   - Dependências: yaml@2, semver@7
 *   - Adicione "type": "module" no package.json (ou use extensão .mjs)
 *
 * Exemplos de uso:
 *
 *   1. Gerar o workflow do GitHub Actions (.github/workflows/monorepo--migrate.yml):
 *      node rodverso.js init-workflow              # Apenas imprime o YAML no stdout
 *      node rodverso.js init-workflow --apply      # Grava o arquivo no repositório
 *
 *   2. Auditar repositórios de origem (somente leitura: variáveis, secrets, tags, workflows):
 *      node rodverso.js scan repo-a owner/repo-b
 *
 *   3. Simular a migração de código em um worktree isolado (dry-run completo):
 *      node rodverso.js plan repo-a owner/repo-b
 *
 *   4. Executar a migração de código:
 *      node rodverso.js migrate repo-a --apply              # Cria branch local migration/rodverso/<uuid>
 *      node rodverso.js migrate repo-a --apply --push       # Faz push da branch para origin
 *      node rodverso.js migrate repo-a --apply --pr         # Faz push e abre Pull Request como draft
 *
 *   5. Migrar recursos remotos (executados separadamente por segurança):
 *      node rodverso.js resources repo-a --apply
 *      node rodverso.js environments repo-a --apply --confirm-environments
 *      node rodverso.js releases repo-a --apply --confirm-releases
 *
 *   6. Auditar dependências (package.json) do monorepo atual:
 *      node rodverso.js verify
 *
 *   7. Inspecionar, retomar ou reverter uma migração pelo UUID do relatório (.rodverso/reports/<uuid>.json):
 *      node rodverso.js status <uuid>
 *      node rodverso.js resume <uuid> --apply --pr
 *      node rodverso.js rollback <uuid> --apply --confirm-rollback
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import semver from 'semver';

const args = process.argv.slice(2);
const command = args.shift() || 'help';
const flags = new Set(args.filter((x) => x.startsWith('--')));
const repos = args
  .filter((x) => !x.startsWith('--'))
  .map((x) => (x.includes('/') ? x : `rodkisten/${x}`));

const MAX_BUF = 128 * 1024 * 1024;

function run(bin, a, cwd = process.cwd(), input = undefined) {
  try {
    return execFileSync(bin, a, {
      cwd,
      input,
      encoding: 'utf8',
      maxBuffer: MAX_BUF,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const stderr = (err.stderr || '').toString('utf8').trim();
    const detail = stderr ? `: ${stderr.split('\n').slice(-3).join(' | ')}` : '';
    const wrapped = new Error(`${bin} ${a[0] || ''} failed${detail}`);
    wrapped.status = err.status;
    throw wrapped;
  }
}

const git = (...a) => run('git', a);
const root = git('rev-parse', '--show-toplevel');
process.chdir(root);

const gh = (...a) => run('gh', a, root);
const api = (e) => {
  const res = gh('api', e);
  return res ? JSON.parse(res) : null;
};

function pages(e) {
  const res = gh('api', '--paginate', '--slurp', e);
  if (!res) return [];
  return JSON.parse(res).flatMap((p) => {
    if (Array.isArray(p)) return p;
    if (p && typeof p === 'object') {
      const arrayProp = Object.values(p).find(Array.isArray);
      return arrayProp || [];
    }
    return [];
  });
}

const id = randomUUID();
const reviews = [];
const report = {
  id,
  command,
  projects: [],
  conflicts: [],
  changes: [],
  dependencies: [],
  journal: [],
};
const out = path.join(root, '.rodverso', 'reports', `${id}.json`);

function save() {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, out);
}

function review(message) {
  reviews.push(message);
  report.reviews = reviews;
  save();
}

function block(message) {
  report.conflicts.push(message);
  save();
}

function check(ok, msg) {
  if (!ok) throw new Error(msg);
}

function namespace(p, n) {
  return `${p.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}__${n}`;
}

function files(cwd) {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUF,
  })
    .split('\0')
    .filter(Boolean);
}

const read = (f) => fs.readFileSync(f, 'utf8');
function write(f, s) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s);
}

function inventory(repo) {
  const r = api(`repos/${repo}`);
  check(r && !r.archived && !r.fork && !r.disabled, `Unsupported repository ${repo}`);

  const base = `repos/${repo}`;
  const resources = {};
  const endpoints = {
    variables: 'actions/variables',
    secrets: 'actions/secrets',
    environments: 'environments',
    workflows: 'actions/workflows',
    tags: 'tags',
    releases: 'releases',
    labels: 'labels',
    milestones: 'milestones',
    rulesets: 'rulesets',
    hooks: 'hooks',
    keys: 'keys',
  };

  for (const [k, v] of Object.entries(endpoints)) {
    try {
      resources[k] = pages(`${base}/${v}`).map(({ value, ...rest }) =>
        k === 'variables'
          ? rest
          : { id: rest.id, name: rest.name, tag_name: rest.tag_name, path: rest.path }
      );
    } catch {
      block(`${repo}: cannot inventory ${k}`);
      resources[k] = [];
    }
  }

  const headCommit = api(`${base}/commits/${encodeURIComponent(r.default_branch)}`);
  check(headCommit?.sha, `${repo}: cannot resolve default branch SHA`);

  return {
    repo,
    name: r.name,
    branch: r.default_branch,
    private: r.private,
    sha: headCommit.sha,
    resources,
  };
}

function rewrite(s, p) {
  return s.replace(/\$\{\{[\s\S]*?\}\}/g, (e) =>
    e
      .replace(/\b(vars|secrets)\.([A-Za-z0-9_]+)/g, (m, k, n) =>
        p.maps[k][n] ? `${k}.${p.maps[k][n]}` : m
      )
      .replace(/\b(vars|secrets)\[\s*(['"])([A-Za-z0-9_]+)\2\s*\]/g, (m, k, q, n) =>
        p.maps[k][n] ? `${k}[${q}${p.maps[k][n]}${q}]` : m
      )
  );
}

function auditDependencies(cwd) {
  const deps = new Map();
  const names = new Set();

  for (const f of files(cwd).filter((f) => path.basename(f) === 'package.json')) {
    if (/(^|\/)(node_modules|fixtures?|__tests__|tests?)\//.test(f)) continue;
    try {
      const p = JSON.parse(read(path.join(cwd, f)));
      if (p.name && names.has(p.name)) block(`Duplicate package: ${p.name}`);
      if (p.name) names.add(p.name);

      for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const [n, v] of Object.entries(p[k] || {})) {
          if (!deps.has(n)) deps.set(n, []);
          deps.get(n).push({ file: f, range: v, type: k });
        }
      }
    } catch {
      block(`Invalid manifest: ${f}`);
    }
  }

  report.dependencies = [...deps].map(([name, consumers]) => {
    const ranges = [...new Set(consumers.map((c) => c.range))];
    let status = 'unknown';
    if (ranges.length === 1) {
      status = 'identical';
    } else if (ranges.every((x) => semver.validRange(x))) {
      status = ranges.every((a) => ranges.every((b) => semver.intersects(a, b)))
        ? 'potentially-compatible'
        : 'incompatible';
    }
    return { name, consumers, ranges, status };
  });
}

function importProject(cwd, p) {
  const dest = `packages/${p.name}`;
  check(!fs.existsSync(path.join(cwd, dest)), `Destination exists: ${dest}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rodverso-source-'));

  try {
    run('gh', ['repo', 'clone', p.repo, tmp, '--', '--no-checkout'], root);
    run('git', ['checkout', '--detach', p.sha], tmp);

    const tracked = files(tmp);
    check(
      !tracked.some((f) => fs.lstatSync(path.join(tmp, f)).isSymbolicLink()),
      'Symlinks require manual review'
    );

    const lower = new Set();
    for (const f of tracked) {
      check(!lower.has(f.toLowerCase()), `Case collision: ${f}`);
      lower.add(f.toLowerCase());
    }

    check(!tracked.includes('.gitmodules'), 'Submodules require manual migration');
    check(
      !tracked.some(
        (f) => path.basename(f) === '.gitattributes' && read(path.join(tmp, f)).includes('filter=lfs')
      ),
      'LFS requires manual migration'
    );

    run(
      'git',
      ['subtree', 'add', `--prefix=${dest}`, '-m', `chore(rodverso): import ${p.repo}`, tmp, p.sha],
      cwd
    );
    report.journal.push({ type: 'import', repo: p.repo, sha: p.sha, dest });
    save();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function transform(cwd, p) {
  const prefix = `packages/${p.name}`;
  const tracked = files(cwd).filter((f) => f.startsWith(`${prefix}/`));
  const workflows = tracked.filter((f) =>
    new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.github/workflows/[^/]+\\.ya?ml$`).test(f)
  );

  const names = {};
  for (const f of workflows) {
    const d = YAML.parse(read(path.join(cwd, f))) ?? {};
    if (d.name) names[d.name] = `${p.name} · ${d.name}`;
  }

  for (const f of workflows) {
    const full = path.join(cwd, f);
    const d = YAML.parse(read(full)) ?? {};

    if (d.name) d.name = names[d.name];
    if (d.on?.workflow_run?.workflows) {
      d.on.workflow_run.workflows = d.on.workflow_run.workflows.map((n) => names[n] || n);
    }

    for (const job of Object.values(d.jobs || {})) {
      if (!job || typeof job !== 'object') continue;
      if (job.uses) {
        review(`Review reusable workflow: ${f}`);
        continue;
      }

      job.defaults ??= {};
      job.defaults.run ??= {};
      const wd = job.defaults.run['working-directory'] || d.defaults?.run?.['working-directory'] || '.';

      if (typeof wd === 'string' && !wd.includes('${{') && !path.isAbsolute(wd)) {
        job.defaults.run['working-directory'] = path.posix.join(prefix, wd);
      } else {
        block(`Dynamic working directory: ${f}`);
      }

      if (job.environment) {
        const n = typeof job.environment === 'string' ? job.environment : job.environment.name;
        if (typeof n === 'string' && !n.includes('${{')) {
          if (typeof job.environment === 'string') job.environment = `${p.name}-${n}`;
          else job.environment.name = `${p.name}-${n}`;
        } else {
          block(`Dynamic environment: ${f}`);
        }
      }

      for (const step of job.steps || []) {
        if (step.uses?.startsWith('./.github/actions/')) {
          step.uses = `./${prefix}/${step.uses.slice(2)}`;
        }
        if (step.with || step['working-directory']) {
          review(`Review action inputs or step paths: ${f}`);
        }
      }
    }

    for (const event of ['push', 'pull_request']) {
      for (const key of ['paths', 'paths-ignore']) {
        if (Array.isArray(d.on?.[event]?.[key])) {
          d.on[event][key] = d.on[event][key].map((v) =>
            v.startsWith('!') ? `!${prefix}/${v.slice(1)}` : `${prefix}/${v}`
          );
        }
      }
    }

    const target = `.github/workflows/${p.name}--${path.basename(f)}.disabled`;
    check(!fs.existsSync(path.join(cwd, target)), `Workflow collision: ${target}`);
    write(path.join(cwd, target), rewrite(YAML.stringify(d), p));
    fs.unlinkSync(full);
    report.changes.push({ from: f, to: target });
    review(`Workflow remains disabled pending semantic review: ${target}`);
  }

  for (const f of tracked.filter((f) => !workflows.includes(f))) {
    const full = path.join(cwd, f);
    if (!fs.existsSync(full) || !fs.lstatSync(full).isFile()) continue;
    const b = fs.readFileSync(full);
    if (b.includes(0)) continue;

    const before = b.toString('utf8');
    const after = rewrite(before, p);
    if (before !== after) {
      write(full, after);
      report.changes.push({ file: f, type: 'expression' });
    }
    if (after.includes(p.repo)) review(`Review original repository reference: ${f}`);
    if (/\b(?:vars|secrets)\[\s*[^'"\s]/.test(after)) block(`Dynamic expression: ${f}`);
  }

  const workspace = path.join(cwd, 'pnpm-workspace.yaml');
  const doc = YAML.parseDocument(
    fs.existsSync(workspace) ? read(workspace) : 'packages: []\n'
  );
  check(!doc.errors.length, 'Invalid workspace YAML');
  const patterns = new Set(doc.get('packages')?.toJSON() || []);

  for (const f of tracked.filter((f) => path.basename(f) === 'package.json')) {
    if (/(^|\/)(node_modules|fixtures?|__tests__|tests?)\//.test(f)) continue;
    const m = JSON.parse(read(path.join(cwd, f)));
    if (m.name) patterns.add(path.posix.dirname(f));
  }

  doc.set('packages', [...patterns]);
  write(workspace, doc.toString());
}

function resourcePlan(projects, destination, apply) {
  const base = `repos/${destination}`;
  const existing = new Map(pages(`${base}/actions/variables`).map((v) => [v.name, v.value]));
  const secrets = new Set(pages(`${base}/actions/secrets`).map((v) => v.name));
  const operations = [];
  const seen = new Set();

  for (const p of projects) {
    for (const v of pages(`repos/${p.repo}/actions/variables`)) {
      const name = namespace(p.name, v.name);
      check(!seen.has(`var:${name}`), `Variable namespace collision: ${name}`);
      seen.add(`var:${name}`);
      if (existing.has(name)) {
        check(existing.get(name) === v.value, `Existing variable differs: ${name}`);
        continue;
      }
      operations.push({ kind: 'variable', name, value: v.value });
    }

    for (const v of p.resources.secrets) {
      const name = namespace(p.name, v.name);
      check(!seen.has(`secret:${name}`), `Secret namespace collision: ${name}`);
      seen.add(`secret:${name}`);
      if (secrets.has(name)) {
        review(`Existing secret; equality unknown: ${name}`);
        continue;
      }
      if (!Object.hasOwn(process.env, name) || !process.env[name]) {
        review(`Missing authorized secret: ${name}`);
        continue;
      }
      operations.push({ kind: 'secret', name, value: process.env[name] });
    }
  }

  report.resourcePlan = operations.map(({ kind, name }) => ({ kind, name }));
  save();
  if (!apply) return;

  for (const op of operations) {
    const entry = { type: op.kind, name: op.name, repository: destination, state: 'pending' };
    report.journal.push(entry);
    save();

    const endpoint = `${base}/actions/${op.kind === 'variable' ? 'variables' : 'secrets'}`;
    check(!pages(endpoint).some((v) => v.name === op.name), `Resource appeared during migration: ${op.name}`);

    if (op.kind === 'variable') {
      run('gh', ['api', '--method', 'POST', endpoint, '--input', '-'], root, JSON.stringify({ name: op.name, value: op.value }));
    } else {
      run('gh', ['secret', 'set', op.name, '--repo', destination], root, op.value);
    }
    entry.state = 'created';
    save();
  }
}

function referenceIndex(cwd, projects, destination) {
  const index = [];
  for (const p of projects) {
    const prefix = `packages/${p.name}`;
    const workflows = files(cwd)
      .filter((f) => f.startsWith(`${prefix}/.github/workflows/`) && /\.ya?ml$/.test(f))
      .map((f) => ({ old: path.basename(f), next: `${p.name}--${path.basename(f)}.disabled` }));
    index.push({ repo: p.repo, prefix, workflows, destination, branch: p.branch });
  }
  report.referenceGraph = index;
  save();
  return index;
}

function globalReferences(cwd, index) {
  const tracked = files(cwd);
  report.references = [];
  const record = (file, line, kind, status, source, target) =>
    report.references.push({ file, line, kind, status, source, target });

  for (const file of tracked) {
    const full = path.join(cwd, file);
    if (!fs.existsSync(full) || !fs.lstatSync(full).isFile()) continue;
    const bytes = fs.readFileSync(full);
    if (bytes.includes(0)) continue;
    const before = bytes.toString('utf8');
    if (!Buffer.from(before).equals(bytes)) continue;

    const owner = index.find(
      (p) =>
        file.startsWith(`${p.prefix}/`) ||
        file.startsWith(`.github/workflows/${p.prefix.split('/').at(-1)}--`)
    );
    let after = before;

    if (/\.(md|mdx|rst)$/i.test(file)) {
      for (const p of index) {
        for (const w of p.workflows) {
          const old = `https://github.com/${p.repo}/actions/workflows/${w.old}/badge.svg`;
          if (after.includes(old)) record(file, null, 'badge', 'preserved', old, null);
        }
      }
    }

    if (owner && /\.ya?ml\.disabled$/.test(file)) {
      const doc = YAML.parseDocument(after);
      check(!doc.errors.length, `Invalid workflow ${file}`);
      const jobs = doc.get('jobs');
      if (YAML.isMap(jobs)) {
        for (const pair of jobs.items) {
          const job = pair.value;
          if (!YAML.isMap(job)) continue;
          const uses = job.get('uses');
          if (typeof uses !== 'string') continue;
          const w = owner.workflows.find((w) => uses === `./.github/workflows/${w.old}`);
          if (w) {
            const target = `./.github/workflows/${w.next}`;
            job.set('uses', target);
            record(file, null, 'reusable-workflow', 'resolved', uses, target);
          }
        }
      }
      after = doc.toString();
    }

    if (after !== before) {
      write(full, after);
      report.changes.push({ file, type: 'global-reference' });
    }

    const lines = after.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const p of index) {
        if (lines[i].includes(p.repo)) {
          record(file, i + 1, 'repository', 'ambiguous', p.repo, p.destination);
        }
        for (const w of p.workflows) {
          if (
            lines[i].includes(`.github/workflows/${w.old}`) ||
            lines[i].includes(`gh workflow run ${w.old}`)
          ) {
            record(file, i + 1, 'workflow', 'unresolved', w.old, w.next);
          }
        }
      }
    }
  }

  for (const r of report.references) {
    if (r.status === 'unresolved') block(`Unresolved workflow reference: ${r.file}:${r.line}`);
    else if (r.status === 'ambiguous') review(`Repository reference requires semantic review: ${r.file}:${r.line}`);
  }
  save();
}

function environmentPlan(projects, destination, apply) {
  const base = `repos/${destination}`;
  const existing = new Set(pages(`${base}/environments`).map((e) => e.name.toLowerCase()));
  const operations = [];
  const seen = new Set();
  report.environmentPlan = [];

  for (const p of projects) {
    for (const item of pages(`repos/${p.repo}/environments`)) {
      const source = `repos/${p.repo}/environments/${encodeURIComponent(item.name)}`;
      const name = `${p.name}-${item.name}`;
      const key = name.toLowerCase();
      check(name.length <= 255, 'Environment name too long');
      check(!seen.has(key), `Environment namespace collision: ${name}`);
      seen.add(key);

      const detail = api(source);
      const variables = pages(`${source}/variables`);
      const secrets = pages(`${source}/secrets`);
      const rules = detail?.protection_rules || [];
      const policy = detail?.deployment_branch_policy;

      const entry = {
        project: p.repo,
        source: item.name,
        destination: name,
        protectionTypes: rules.map((r) => r.type),
        branchPolicy: policy || null,
        variables: variables.map((v) => namespace(p.name, v.name)),
        secrets: secrets.map((v) => namespace(p.name, v.name)),
        status: 'planned',
      };
      report.environmentPlan.push(entry);

      if (existing.has(key)) {
        entry.status = 'blocked';
        block(`Existing environment requires equivalence review: ${name}`);
        continue;
      }
      if (rules.length || policy || detail?.can_admins_bypass === false) {
        entry.status = 'blocked';
        block(`Protected environment requires manual policy migration: ${name}`);
        continue;
      }

      const missing = entry.secrets.filter((n) => !Object.hasOwn(process.env, n) || !process.env[n]);
      if (missing.length) {
        entry.status = 'blocked';
        block(`Missing authorized environment secrets: ${name} / ${missing.join(', ')}`);
        continue;
      }
      operations.push({ name, variables, secrets, p, entry });
    }
  }

  save();
  if (!apply) return;

  check(!report.conflicts.length, 'Environment preflight blocked');
  check(flags.has('--confirm-environments'), 'Pass --confirm-environments to authorize remote creation');

  for (const op of operations) {
    const endpoint = `${base}/environments/${encodeURIComponent(op.name)}`;
    check(
      !pages(`${base}/environments`).some((e) => e.name.toLowerCase() === op.name.toLowerCase()),
      `Environment appeared concurrently: ${op.name}`
    );

    const journal = { type: 'environment', name: op.name, repository: destination, state: 'pending' };
    report.journal.push(journal);
    save();

    run('gh', ['api', '--method', 'PUT', endpoint, '--input', '-'], root, JSON.stringify({ wait_timer: 0, reviewers: [], deployment_branch_policy: null }));
    journal.state = 'created';
    save();

    for (const v of op.variables) {
      const name = namespace(op.p.name, v.name);
      const j = { type: 'environment-variable', environment: op.name, name, state: 'pending' };
      report.journal.push(j);
      save();
      run('gh', ['api', '--method', 'POST', `${endpoint}/variables`, '--input', '-'], root, JSON.stringify({ name, value: v.value }));
      j.state = 'created';
      save();
    }

    for (const v of op.secrets) {
      const name = namespace(op.p.name, v.name);
      const j = { type: 'environment-secret', environment: op.name, name, state: 'pending' };
      report.journal.push(j);
      save();
      check(!pages(`${endpoint}/secrets`).some((x) => x.name === name), `Secret appeared concurrently: ${name}`);
      run('gh', ['secret', 'set', name, '--repo', destination, '--env', op.name], root, process.env[name]);
      j.state = 'created';
      save();
    }

    const actual = api(endpoint);
    check(!(actual?.protection_rules || []).length && !actual?.deployment_branch_policy, 'Unexpected destination protection configuration');

    const vars = new Set(pages(`${endpoint}/variables`).map((v) => v.name));
    const secrets = new Set(pages(`${endpoint}/secrets`).map((v) => v.name));
    check(
      op.entry.variables.every((n) => vars.has(n)) && op.entry.secrets.every((n) => secrets.has(n)),
      'Environment metadata verification failed'
    );
    op.entry.status = 'verified-metadata';
    save();
  }
}

function releasePlan(projects, destination, apply) {
  const base = `repos/${destination}`;
  const existing = new Set(pages(`${base}/tags`).map((t) => t.name));
  const releases = pages(`${base}/releases`);
  const planned = new Set();
  const operations = [];
  report.releasePlan = [];

  for (const p of projects) {
    const source = `repos/${p.repo}`;
    const tags = pages(`${source}/tags`);
    const sourceReleases = pages(`${source}/releases`);

    for (const t of tags) {
      const name = `${p.name}--${t.name}`;
      const entry = { project: p.repo, sourceTag: t.name, destinationTag: name, commit: t.commit?.sha, status: 'planned' };
      report.releasePlan.push(entry);

      if (planned.has(name) || existing.has(name)) {
        entry.status = 'blocked';
        block(`Tag collision: ${name}`);
        continue;
      }
      planned.add(name);

      if (!/^[a-f0-9]{40}$/i.test(entry.commit || '')) {
        entry.status = 'blocked';
        block(`Missing tag commit: ${name}`);
        continue;
      }

      const ref = api(`${source}/git/ref/tags/${encodeURIComponent(t.name)}`);
      if (ref?.object?.type !== 'commit') {
        entry.status = 'blocked';
        block(`Annotated tag requires preservation of tag object: ${name}`);
        continue;
      }

      const r = sourceReleases.find((r) => r.tag_name === t.name);
      if (r) {
        const assets = pages(`${source}/releases/${r.id}/assets`);
        entry.release = {
          id: r.id,
          prerelease: r.prerelease,
          assets: assets.map((a) => ({ id: a.id, name: a.name, size: a.size, digest: a.digest || null })),
          sourceURL: r.html_url,
        };
        if (releases.some((x) => x.tag_name === name)) {
          entry.status = 'blocked';
          block(`Release collision: ${name}`);
          continue;
        }
        if (assets.length) {
          entry.status = 'blocked';
          block(`Release assets require verified transfer: ${name}`);
          continue;
        }
      }
      operations.push({ entry, r });
    }

    for (const r of sourceReleases) {
      if (!tags.some((t) => t.name === r.tag_name)) {
        block(`Release without existing source tag: ${p.repo}/${r.tag_name}`);
      }
    }
  }

  save();
  if (!apply) return;

  check(flags.has('--confirm-releases'), 'Pass --confirm-releases to authorize remote tag creation and draft releases');
  check(!report.conflicts.length, 'Release preflight blocked');

  for (const { entry } of operations) {
    const c = api(`${base}/git/commits/${entry.commit}`);
    check(c?.sha === entry.commit, 'Source history not available in destination');
  }

  for (const { entry, r } of operations) {
    const j = { type: 'tag', repository: destination, name: entry.destinationTag, sha: entry.commit, state: 'pending' };
    report.journal.push(j);
    save();

    run('gh', ['api', '--method', 'POST', `${base}/git/refs`, '--input', '-'], root, JSON.stringify({ ref: `refs/tags/${entry.destinationTag}`, sha: entry.commit }));
    j.state = 'created';
    save();

    const actual = api(`${base}/git/ref/tags/${encodeURIComponent(entry.destinationTag)}`);
    check(actual?.object?.sha === entry.commit, 'Tag verification failed');

    if (r) {
      const jr = { type: 'release', repository: destination, tag: entry.destinationTag, state: 'pending' };
      report.journal.push(jr);
      save();
      const created = JSON.parse(
        run(
          'gh',
          ['api', '--method', 'POST', `${base}/releases`, '--input', '-'],
          root,
          JSON.stringify({
            tag_name: entry.destinationTag,
            name: r.name || entry.destinationTag,
            body: `Migrated from ${r.html_url}\n\n${r.body || ''}`,
            draft: true,
            prerelease: !!r.prerelease,
          })
        )
      );
      jr.id = created.id;
      jr.state = 'created';
      save();
      check(created.draft === true, 'Release is not a draft');
    }
    entry.status = 'verified';
    save();
  }
}

function transaction() {
  const target = repos[0]?.split('/').pop();
  check(target && /^[a-f0-9-]{36}$/i.test(target), 'Specify a migration UUID');
  const file = path.join(root, '.rodverso', 'reports', `${target}.json`);
  const previous = JSON.parse(read(file));
  check(previous.id === target && Array.isArray(previous.journal), 'Invalid journal');
  report.parentMigration = target;

  const destination = JSON.parse(gh('repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'));
  const lock = `${file}.lock`;
  const fd = fs.openSync(lock, 'wx', 0o600);

  try {
    report.recovery = previous.journal.map((j, index) => ({
      index,
      type: j.type,
      name: j.name || j.tag || j.dest,
      state: j.state || 'recorded',
      action: j.state === 'pending' ? 'manual-reconcile' : 'inspect',
    }));

    const branch = previous.branch;
    const commit = previous.commit;
    const validBranch = typeof branch === 'string' && branch === `migration/rodverso/${target}`;
    const validCommit = typeof commit === 'string' && /^[a-f0-9]{40}$/i.test(commit);
    let local = null;
    let remote = null;

    if (validBranch) {
      try {
        local = git('rev-parse', '--verify', `refs/heads/${branch}`);
      } catch {}
      const listing = git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`);
      remote = listing ? listing.split(/\s+/)[0] : null;
    }

    report.checkpoint = { branch, commit, local, remote };
    save();

    if (command === 'status') return;

    check(validBranch && validCommit, 'No completed code checkpoint; inspect journal manually');
    check(!previous.conflicts?.length, 'Previous migration has unresolved conflicts');
    check(!previous.journal.some((j) => j.state === 'pending'), 'Uncertain remote operation; reconcile manually');
    check(local === commit, 'Local checkpoint missing or changed');
    check(!remote || remote === commit, 'Remote branch changed');
    check(!previous.destination || previous.destination === destination.nameWithOwner, 'Destination changed');

    if (command === 'resume') {
      check(previous.destination === destination.nameWithOwner, 'Legacy journal lacks verified destination');
      check(previous.phase === 'code-validated' || previous.phase === 'published', 'Checkpoint was not validated');
      if (!flags.has('--apply')) return;

      if (!remote) {
        report.journal.push({ type: 'push', branch, sha: commit, state: 'pending' });
        save();
        git('push', 'origin', branch);
        report.journal.at(-1).state = 'created';
        save();
      }

      if (flags.has('--pr')) {
        const existing = JSON.parse(
          gh('pr', 'list', '--repo', destination.nameWithOwner, '--head', branch, '--state', 'all', '--json', 'url,state')
        );
        if (existing.length) {
          check(existing.some((p) => p.state === 'OPEN'), 'Existing PR is closed or merged');
          report.pr = existing.find((p) => p.state === 'OPEN').url;
        } else {
          report.journal.push({ type: 'pr', branch, state: 'pending' });
          save();
          report.pr = gh(
            'pr',
            'create',
            '--repo',
            destination.nameWithOwner,
            '--draft',
            '--head',
            branch,
            '--base',
            destination.defaultBranchRef.name,
            '--title',
            'Rodverso migration',
            '--body',
            `Resume migration ${target}`
          );
          report.journal.at(-1).state = 'created';
          save();
        }
      }
    } else {
      check(!remote, 'Published branches require manual rollback');
      check(!previous.journal.some((j) => j.type !== 'import'), 'Remote resources require manual rollback');
      report.rollbackPlan = { branch, commit, action: 'delete-local-branch-only' };
      save();
      if (!flags.has('--apply')) return;
      check(flags.has('--confirm-rollback'), 'Pass --confirm-rollback');
      report.journal.push({ type: 'local-branch-delete', branch, sha: commit, state: 'pending' });
      save();
      check(
        !git('worktree', 'list', '--porcelain').split('\n').includes(`branch refs/heads/${branch}`),
        'Branch is checked out'
      );
      git('update-ref', '-d', `refs/heads/${branch}`, commit);
      report.journal.at(-1).state = 'created';
      save();
    }
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

function initWorkflow() {
  const target = path.join(root, '.github/workflows/monorepo--migrate.yml');
  const scriptName = path.basename(process.argv[1] || 'rodverso.js');
  const workflow = String.raw`name: '🪐🌎🌎🗺️ Rodverso · Migration'
on:
  workflow_dispatch:
    inputs:
      mode:
        type: choice
        options: [audit, plan, apply]
        default: plan
      repositories:
        type: string
        required: true
        description: 'Space-separated owner/repo names'
permissions:
  contents: read
concurrency:
  group: rodverso-migration
  cancel-in-progress: false
jobs:
  migration:
    if: github.ref_name == github.event.repository.default_branch
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Install trusted migration tooling
        shell: bash
        run: |
          set -euo pipefail
          mkdir -p "$RUNNER_TEMP/rodverso"
          cp __SCRIPT__ "$RUNNER_TEMP/rodverso/__SCRIPT__"
          npm install --prefix "$RUNNER_TEMP/rodverso" --ignore-scripts --no-audit --no-fund yaml@2 semver@7
          node --check "$RUNNER_TEMP/rodverso/__SCRIPT__"
      - uses: actions/create-github-app-token@v2
        id: app
        with:
          app-id: __APP_ID__
          private-key: __APP_KEY__
          owner: __OWNER__
      - name: Run migration
        shell: bash
        env:
          GH_TOKEN: __TOKEN__
          MODE: __MODE__
          REPOSITORIES: __REPOS__
          GIT_LFS_SKIP_SMUDGE: '1'
        run: |
          set -euo pipefail
          git config user.name 'Rod Migration Bot'
          git config user.email 'rod-migration-bot@users.noreply.github.com'
          git config core.hooksPath /dev/null
          gh auth setup-git
          read -r -a repos <<< "$REPOSITORIES"
          (( ${#repos[@]} > 0 ))
          for repo in "${repos[@]}"; do
            [[ "$repo" =~ ^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)?$ ]] || exit 1
          done
          case "$MODE" in
            audit) cmd=scan; extra=();;
            plan) cmd=plan; extra=();;
            apply) cmd=migrate; extra=(--apply --pr);;
            *) exit 1;;
          esac
          node "$RUNNER_TEMP/rodverso/__SCRIPT__" "$cmd" "${repos[@]}" ${extra[@]+"${extra[@]}"}
      - name: Report status
        if: always()
        run: |
          printf '## Rodverso migration\nMode: %s\n' "$MODE" >> "$GITHUB_STEP_SUMMARY"
        env:
          MODE: __MODE__
`;

  const expr = (x) => `$` + `{{ ${x} }}`;
  const content = workflow
    .replaceAll('__SCRIPT__', scriptName)
    .replaceAll('__APP_ID__', expr('vars.ROD_APP_ID'))
    .replaceAll('__APP_KEY__', expr('secrets.ROD_APP_PRIVATE_KEY'))
    .replaceAll('__OWNER__', expr('github.repository_owner'))
    .replaceAll('__TOKEN__', expr('steps.app.outputs.token'))
    .replaceAll('__MODE__', expr('inputs.mode'))
    .replaceAll('__REPOS__', expr('inputs.repositories'));

  const doc = YAML.parseDocument(content);
  check(!doc.errors.length, 'Generated workflow is invalid YAML');

  if (!flags.has('--apply')) {
    console.log(content);
    return;
  }
  check(!fs.existsSync(target) || read(target) === content, 'Workflow already exists with different content');
  write(target, content);
  console.log(target);
}

function main() {
  if (command === 'init-workflow') return initWorkflow();
  if (['status', 'resume', 'rollback'].includes(command)) return transaction();

  if (command === 'help') {
    console.log(
      'Usage: node rodverso.js init-workflow|scan|plan|migrate|verify|resources|environments|releases|status|resume|rollback [owner/repo ...] [--apply] [--push] [--pr]'
    );
    return;
  }

  if (command === 'verify') {
    auditDependencies(root);
    save();
    return;
  }

  check(['scan', 'plan', 'migrate', 'resources', 'environments', 'releases'].includes(command), 'Unsupported command');
  check(repos.length, 'Specify repositories explicitly');

  const destination = JSON.parse(gh('repo', 'view', '--json', 'nameWithOwner,isPrivate,defaultBranchRef'));
  report.destination = destination.nameWithOwner;
  save();

  const seenNames = new Set();
  for (const repo of repos) {
    const p = inventory(repo);
    check(repo !== destination.nameWithOwner, 'Cannot import self');
    check(!p.private || destination.isPrivate, 'Private source into public destination');
    check(!seenNames.has(p.name.toLowerCase()), `Duplicate project target name: ${p.name}`);
    seenNames.add(p.name.toLowerCase());

    p.maps = {
      vars: Object.fromEntries(p.resources.variables.map((v) => [v.name, namespace(p.name, v.name)])),
      secrets: Object.fromEntries(p.resources.secrets.map((v) => [v.name, namespace(p.name, v.name)])),
    };

    for (const e of p.resources.environments) {
      const base = `repos/${p.repo}/environments/${encodeURIComponent(e.name)}`;
      for (const [kind, field] of [
        ['variables', 'vars'],
        ['secrets', 'secrets'],
      ]) {
        for (const v of pages(`${base}/${kind}`)) {
          p.maps[field][v.name] = namespace(p.name, v.name);
        }
      }
    }
    report.projects.push(p);
  }
  save();

  if (command === 'releases') {
    check(!report.conflicts.length, 'Inventory incomplete');
    releasePlan(report.projects, destination.nameWithOwner, flags.has('--apply'));
    return;
  }
  if (command === 'environments') {
    check(!report.conflicts.length, 'Inventory incomplete');
    environmentPlan(report.projects, destination.nameWithOwner, flags.has('--apply'));
    return;
  }
  if (command === 'resources') {
    check(!report.conflicts.length, 'Inventory incomplete');
    resourcePlan(report.projects, destination.nameWithOwner, flags.has('--apply'));
    return;
  }
  if (command === 'scan') return;

  check(!git('status', '--porcelain', '--untracked-files=no'), 'Commit or stash tracked changes first');

  const base = `origin/${destination.defaultBranchRef.name}`;
  git('fetch', 'origin', destination.defaultBranchRef.name);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rodverso-work-'));
  const branch = `migration/rodverso/${id}`;
  const apply = command === 'migrate' && flags.has('--apply');

  try {
    git('worktree', 'add', ...(apply ? ['-b', branch] : ['--detach']), cwd, base);

    for (const p of report.projects) importProject(cwd, p);

    const index = referenceIndex(cwd, report.projects, destination.nameWithOwner);

    for (const p of report.projects) {
      transform(cwd, p);
      if (p.resources.secrets.length) {
        review(`Secret values require authorized transfer before activation: ${p.repo}`);
      }
      if (p.resources.environments.length) {
        review(`Environment protections require review before activation: ${p.repo}`);
      }
    }

    run('git', ['add', '-A'], cwd);
    globalReferences(cwd, index);
    run('git', ['add', '-A'], cwd);
    auditDependencies(cwd);

    const unmerged = run('git', ['diff', '--cached', '--name-only', '--diff-filter=U'], cwd);
    check(!unmerged, `Unmerged conflicts detected: ${unmerged}`);

    if (apply) {
      run('git', ['commit', '-m', 'feat(rodverso): import projects [skip ci]'], cwd);
      report.branch = branch;
      report.commit = run('git', ['rev-parse', 'HEAD'], cwd);
      report.phase = report.conflicts.length ? 'blocked' : 'code-validated';
      save();

      if (flags.has('--push') || flags.has('--pr')) {
        check(!report.conflicts.length, 'Strict validation blocked remote publication');
        report.journal.push({ type: 'push', branch, sha: report.commit, state: 'pending' });
        save();
        run('git', ['push', '-u', 'origin', branch], cwd);
        report.journal.at(-1).state = 'created';
        report.phase = 'published';
        save();
      }

      if (flags.has('--pr')) {
        report.journal.push({ type: 'pr', branch, state: 'pending' });
        save();
        report.pr = gh(
          'pr',
          'create',
          '--draft',
          '--head',
          branch,
          '--base',
          destination.defaultBranchRef.name,
          '--title',
          'Rodverso migration',
          '--body',
          `Migration ${id}. ${process.env.MIGRATION_CHAT_URL || ''}`
        );
        report.journal.at(-1).state = 'created';
        save();
      }
    }
  } finally {
    save();
    try {
      git('worktree', 'remove', '--force', cwd);
    } catch {}
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

try {
  main();
} catch (e) {
  block(`Execution failed: ${e.message}`);
} finally {
  if (command !== 'init-workflow') {
    save();
    console.log(out);
  }
  if (report.conflicts.length) process.exitCode = 1;
}
