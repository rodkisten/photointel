import { parseConfiguration } from './config-reconcile';

export type EnvironmentPreviewEntry = { key: string; value: string; secretName?: string };
export type EnvironmentPreview = { entries: EnvironmentPreviewEntry[]; error: string };

const SECRET_FIELD = /(?:SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|API_KEY|SESSION|PEPPER|AUTH)/i;

/** Never reveal short credentials in full; no confirmation or secret retrieval required. */
export function maskEnvironmentValue(key: string, value: string): string {
  if (!SECRET_FIELD.test(key)) return value;
  if (value.length < 12) return '••••••••';
  return value.slice(0, 3) + '••••••' + value.slice(-3);
}

/** A client-side resolved-key preview; Secret Manager payloads are never accessed. */
export function listEnvironmentPreview(raw: string): EnvironmentPreview {
  try {
    const parsed = parseConfiguration(raw);
    const entries: EnvironmentPreviewEntry[] = [];
    const prefix = parsed.SECRET_NAME_PREFIX?.replace(/-?$/, '-') || 'photointel-';
    for (const [key, value] of Object.entries(parsed)) {
      const compact = /^(?:SECRET|WORKFLOW_SECRET)__([A-Z][A-Z0-9_]*)$/.exec(key);
      const legacy = /^(?:SECRETS|WORKFLOW_SECRETS)__([A-Z][A-Z0-9_]*)__NAME$/.exec(key);
      const reference = compact ? value : value.startsWith('secret://') ? value.slice(9) : '';
      const name = legacy ? value :
        reference ? (reference.split('@')[0] || prefix + (compact?.[1] || key).toLowerCase().replaceAll('_', '-')) : undefined;
      entries.push({ key, value, ...(name ? { secretName: name } : {}) });
    }
    return { entries: entries.sort((a, b) => a.key.localeCompare(b.key)), error: '' };
  } catch (error) {
    return { entries: [], error: error instanceof Error ? error.message : 'Erro ao resolver ambiente' };
  }
}
