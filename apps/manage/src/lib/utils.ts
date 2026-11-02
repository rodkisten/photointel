import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...values: ClassValue[]): string {
  return twMerge(clsx(values));
}
export function date(value?: string): string {
  if (!value) return '—';
  const ts = Date.parse(value);
  return Number.isFinite(ts)
    ? new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(ts)
    : '—';
}
export function state(value?: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  if (['success', 'completed', 'healthy', 'ok'].includes(value || '')) return 'success';
  if (['failed', 'failure', 'error', 'timed_out', 'cancelled'].includes(value || '')) return 'danger';
  if (['pending', 'queued', 'waiting'].includes(value || '')) return 'warning';
  if (['in_progress', 'running', 'requested'].includes(value || '')) return 'info';
  return 'neutral';
}
export function human(value?: string): string {
  return (
    (
      {
        success: 'Sucesso',
        failure: 'Falha',
        completed: 'Concluído',
        in_progress: 'Executando',
        queued: 'Na fila',
        cancelled: 'Cancelado',
        pending: 'Pendente',
        waiting: 'Aguardando',
        timed_out: 'Timeout',
      } as Record<string, string>
    )[value || ''] ||
    value ||
    'Indisponível'
  );
}
