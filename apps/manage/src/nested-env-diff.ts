/** Compare individual entries of a multiline GitHub Actions variable without exposing values. */
export function parseNestedEnv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (raw.trimStart().startsWith('{')) {
    const object: unknown = JSON.parse(raw);
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('JSON deve ser um objeto');
    for (const [key, value] of Object.entries(object)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Chave inválida: ' + key);
      result[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return result;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (!match) throw new Error('Linha inválida em GCP_ENV_VARS');
    if (Object.prototype.hasOwnProperty.call(result, match[1])) throw new Error('Chave duplicada: ' + match[1]);
    result[match[1]] = match[2];
  }
  return result;
}

export function diffNestedEnv(before: string, after: string): Array<{ key: string; kind: 'added' | 'changed' | 'removed' }> {
  const oldEntries = parseNestedEnv(before);
  const newEntries = parseNestedEnv(after);
  return [...new Set([...Object.keys(oldEntries), ...Object.keys(newEntries)])].sort()
    .filter(key => oldEntries[key] !== newEntries[key])
    .map(key => ({ key, kind: !(key in oldEntries) ? 'added' : !(key in newEntries) ? 'removed' : 'changed' }));
}
