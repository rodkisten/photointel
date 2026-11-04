import { ApiError } from '../auth';

export type RouteKind = 'cloudflare' | 'gcp';
export type PathCheck = { pattern: string; kind: 'blob' | 'tree' | 'glob'; exists: boolean; matches: number };
export type DeployRule = {
  id: string; name: string; enabled: boolean; provider: RouteKind;
  target: string; patterns: string[]; created_at: string; updated_at: string;
};
const PATH = /^[A-Za-z0-9_./*?@+!\-[\]{}()]+$/;
export function validatePatterns(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 24)
    throw new ApiError(422, 'ROUTE_PATTERNS', 'Informe de 1 a 24 caminhos por regra');
  const patterns = raw.map((x: unknown) => String(x).trim());
  if (patterns.some((x: string) => !x || x.length > 180 || x.startsWith('/') ||
    x.includes('\\') || x.split('/').some((part: string) => part === '.' || part === '..' || !part) ||
    !PATH.test(x) || /\*{3,}|\?{2,}/.test(x)))
    throw new ApiError(422, 'ROUTE_PATH', 'Padrão inválido: use caminhos relativos, * ou **');
  return [...new Set(patterns)];
}
function esc(char: string): string {
  return /[|\\{}()[\]^$+?.]/.test(char) ? '\\' + char : char;
}
export function pathRegexp(pattern: string): RegExp {
  let result = '^';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; result += '(?:.*/)?'; }
      else result += '.*';
    } else if (pattern[i] === '*') result += '[^/]*';
    else if (pattern[i] === '?') result += '[^/]';
    else result += esc(pattern[i]);
  }
  return new RegExp(result + '$');
}
export function pathMatch(pattern: string, file: string): boolean {
  if (pattern.endsWith('/')) return file.startsWith(pattern);
  if (pattern.includes('*') || pattern.includes('?')) return pathRegexp(pattern).test(file);
  return file === pattern || file.startsWith(pattern + '/');
}
export function matchRules(rules: DeployRule[], changed: string[]): Array<{ rule: DeployRule; files: string[] }> {
  return rules.filter((rule) => rule.enabled).map((rule) => ({
    rule, files: changed.filter((file) => rule.patterns.some((pattern) => pathMatch(pattern, file))),
  })).filter((result) => result.files.length > 0);
}
export type TreeEntry = { path: string; type: 'blob' | 'tree' };
export function checkPaths(patterns: string[], entries: TreeEntry[]): PathCheck[] {
  return patterns.map((pattern) => {
    const isGlob = /[*?]/.test(pattern);
    const exact = entries.find((x) => x.path === pattern.replace(/\/$/, ''));
    const kind = isGlob ? 'glob' : exact?.type || (pattern.endsWith('/') ? 'tree' : 'blob');
    const matches = entries.filter((x) => x.type === 'blob' && pathMatch(pattern, x.path)).length;
    return { pattern, kind, exists: Boolean(exact || matches), matches };
  });
}
export function validateTarget(provider: unknown, target: unknown): { provider: RouteKind; target: string } {
  if (provider === 'gcp' && (target === 'release' || target === 'provision'))
    return { provider, target };
  if (provider === 'cloudflare' && typeof target === 'string' &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(target))
    return { provider, target: target.toLowerCase() };
  throw new ApiError(422, 'ROUTE_TARGET', 'Destino inválido: GCP release/provision ou UUID de Workers Builds');
}
