export const number = (value: unknown) => typeof value === 'number'
  ? new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(value) : '—';
export const date = (value: unknown, time = false) => {
  if (typeof value !== 'string' || !value) return 'Ainda não registrado';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('pt-BR', time
    ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'long' }).format(parsed);
};
export function bytes(value: unknown) {
  if (typeof value !== 'number') return '—';
  if (value < 1024) return `${value} B`;
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${number(value / 1024 ** unit)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
export const text = (value: unknown): string => value === null || value === undefined
  ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
export const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
export const items = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(obj) : [];
export const statusNames: Record<string, string> = {
  queued: 'Na fila', preparing: 'Preparando', running: 'Em execução',
  retrying: 'Nova tentativa', paused: 'Pausado', completed: 'Concluído',
  failed: 'Falhou', cancelled: 'Cancelado', operational: 'Operacional',
  unavailable: 'Indisponível', not_configured: 'Não configurado',
  not_implemented: 'Fora do v1', experimental: 'Experimental', test_only: 'Somente teste',
  pending: 'Pendente', claimed: 'Reservado', mapping_required: 'Vincular fotografia',
  awaiting_approval: 'Aguardando aprovação', processing: 'Processando',
  applied_on_device: 'Aplicado no dispositivo', awaiting_cloud_confirmation: 'Aguardando iCloud',
  conflict: 'Conflito', read_only: 'Somente leitura', write_verified: 'Escrita verificada',
  unverified: 'Não verificado', verified: 'Verificado', ambiguous: 'Ambíguo',
  unmapped: 'Sem vínculo', valid: 'Válida', unknown: 'Não verificada',
};
export const statusLabel = (value: unknown) => statusNames[String(value)] ?? text(value);
