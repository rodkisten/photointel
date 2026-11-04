import { AlertTriangle, FileSearch, RefreshCw, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useAction, useApi } from '../api/client';
import { Empty, ErrorState, Skeleton, Status } from './common';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { jobLogsUrl } from '../lib/diagnostics';

type PreviewJob = {
  id: string;
  job_type: string;
  status: string;
  error_code: string | null;
};

type PreviewFinding = {
  asset_id: string;
  filename: string;
  ingestion_status: string;
  missing_variants: string[];
  invalid_variants: string[];
  available_variants: string[];
  status: 'blocked' | 'processing' | 'failed' | 'missing';
  repairable: boolean;
  repair_stage?: string | null;
  repair_reason?: string | null;
  job: PreviewJob | null;
};

type PreviewAuditPage = {
  total_assets: number;
  total_issues: number;
  items: PreviewFinding[];
  next_cursor: string | null;
  verification: 'catalog_metadata';
  catalog_capacity?: { used: number; limit: number; at_limit: boolean };
};

const labels: Record<string, string> = {
  thumbnail_small: 'Miniatura pequena',
  thumbnail_medium: 'Miniatura média',
  preview_large: 'Prévia grande',
};

export function PreviewAuditDialog({ onClose }: { onClose: () => void }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [repaired, setRepaired] = useState<string[]>([]);
  const [repairError, setRepairError] = useState<Error | null>(null);
  const page = useApi<PreviewAuditPage>(
    `/v1/jobs/previews/audit?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
  );
  const automation = useApi<{
    enabled: boolean;
    interval_minutes: number;
    last_finished_at: string | null;
    next_run_at: string | null;
    last_result?: {
      status: string;
      catalog?: { scanned: number; queued: number; blocked: number; cooldown: number };
      storage?: { checked: number; queued: number; missing_objects: number };
    } | null;
  }>('/v1/jobs/previews/automation', 60_000);
  const repair = useAction<{ created: boolean; message: string }>();
  const repairBatch = useAction<{
    scanned: number;
    queued: number;
    already_active: number;
    failed: number;
    next_cursor: string | null;
    failed_items?: Array<{ asset_id: string; code: string }>;
  }>();
  const [batchRunning, setBatchRunning] = useState(false);
  const [lastBatchFailures, setLastBatchFailures] = useState<Record<string, number>>({});
  const [nextRepairCursor, setNextRepairCursor] = useState<string | null | undefined>(undefined);
  const [batchProgress, setBatchProgress] = useState({
    scanned: 0,
    queued: 0,
    already_active: 0,
    failed: 0,
    batches: 0,
  });

  async function retryBatch() {
    setRepairError(null);
    setBatchRunning(true);
    const reasons: Record<string, number> = {};
    let next = nextRepairCursor ?? null;
    const totals =
      nextRepairCursor === undefined
        ? { scanned: 0, queued: 0, already_active: 0, failed: 0, batches: 0 }
        : { ...batchProgress };
    try {
      // A deliberate limit avoids an unbounded stream of external Apple downloads.
      for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
        const outcome = await repairBatch.mutateAsync({
          url: '/v1/jobs/previews/repair-batch',
          body: { limit: 25, cursor: next, confirm: true },
        });
        totals.scanned += outcome.scanned;
        totals.queued += outcome.queued;
        totals.already_active += outcome.already_active;
        totals.failed += outcome.failed;
        for (const item of outcome.failed_items || []) {
          reasons[item.code] = (reasons[item.code] || 0) + 1;
        }
        setLastBatchFailures({ ...reasons });
        totals.batches++;
        setBatchProgress({ ...totals });
        next = outcome.next_cursor;
        setNextRepairCursor(next);
        if (!next || outcome.scanned === 0) break;
      }
      void page.refetch();
    } catch (error) {
      setRepairError(error instanceof Error ? error : new Error('Não foi possível solicitar o lote'));
    } finally {
      setBatchRunning(false);
    }
  }

  async function retry(finding: PreviewFinding) {
    setRepairError(null);
    try {
      const result = await repair.mutateAsync({
        url: `/v1/jobs/assets/${finding.asset_id}/preview/repair`,
      });
      setRepaired((items) => (items.includes(finding.asset_id) ? items : [...items, finding.asset_id]));
      // The server returns whether a worker was created or merely awakened.
      // Nothing is marked repaired until the preview resources actually exist.
      void page.refetch();
      if (result.message) {
        // The persistent job drawer and /jobs page show the current worker state.
        return;
      }
    } catch (error) {
      setRepairError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(value) => !value && onClose()}
      title="Auditoria de thumbnails e previews"
      description="Busca em todo o catálogo por variantes ausentes, inválidas ou jobs com falha. Nenhum job é criado durante a busca."
    >
      <div className="stack" style={{ maxHeight: '65vh', overflowY: 'auto' }}>
        {page.error ? (
          <ErrorState error={page.error} retry={() => void page.refetch()} />
        ) : page.isPending ? (
          <Skeleton count={3} />
        ) : (
          page.data && (
            <>
              <div className="metrics">
                <div className="metric">
                  <div className="metric-label">Fotos analisadas</div>
                  <div className="metric-value">{page.data.total_assets.toLocaleString('pt-BR')}</div>
                </div>
                <div className="metric">
                  <div className="metric-label">Prévias incompletas</div>
                  <div className="metric-value">{page.data.total_issues.toLocaleString('pt-BR')}</div>
                </div>
              </div>
              <p className="field-help">
                Auditoria dos registros do catálogo, inclusive falhas sem job recente. Não verifica objetos do
                R2 que ainda aparecem como disponíveis no banco.
              </p>
              {page.data.catalog_capacity?.at_limit && (
                <div className="panel" role="alert" style={{ padding: 12, marginBottom: 12 }}>
                  <strong>Catálogo atingiu o limite configurado</strong>
                  <p className="field-help">
                    {page.data.catalog_capacity.used} de {page.data.catalog_capacity.limit} fotos/ativos
                    cadastrados. Isso impede a descoberta de novas fotos, mas não deve bloquear
                    o reparo das já existentes. Verifique DATABASE_PROFILE e CATALOG_ASSET_LIMIT
                    na configuração de produção antes de ampliar a capacidade do banco.
                  </p>
                </div>
              )
              <div className="panel" style={{ padding: 12, marginBottom: 12 }}>
                <strong>Reparo de mídia {automation.data?.enabled ? '· Automação configurada' : '· Automação desativada'}</strong>
                <p className="field-help" role="status">
                  {automation.data?.last_finished_at
                    ? `Última varredura: ${new Date(automation.data.last_finished_at).toLocaleString('pt-BR')}. `
                    : 'Nenhuma varredura concluída registrada. '}
                  {automation.data?.next_run_at
                    ? `Próxima verificação prevista: ${new Date(automation.data.next_run_at).toLocaleString('pt-BR')}.`
                    : 'Confirme se worker/maintenance estão sendo executados pelo Cloud Scheduler.'}
                  {automation.data?.last_result?.catalog && (
                    <>
                      {' '}Último ciclo: {automation.data.last_result.catalog.queued} enfileiradas,
                      {' '}{automation.data.last_result.catalog.blocked} sem fonte recuperável,
                      {' '}{automation.data.last_result.catalog.cooldown} em cooldown.
                    </>
                  )}
                </p>
                <p className="field-help">
                  Enfileira até 100 fotos por vez em lotes de 25, respeitando jobs ativos, mídias bloqueadas e
                  os limites do worker. Nenhuma foto é considerada reparada antes de o processamento terminar.
                </p>
                <div className="form-actions">
                  <Button
                    size="sm"
                    disabled={batchRunning || (nextRepairCursor === null && batchProgress.batches > 0)}
                    onClick={() => void retryBatch()}
                  >
                    <RotateCcw size={14} />
                    {batchRunning
                      ? 'Solicitando lotes…'
                      : nextRepairCursor
                        ? 'Continuar reparo'
                        : 'Reparar fotos em lote'}
                  </Button>
                  <span role="status" aria-live="polite" className="field-help">
                    {batchProgress.scanned} verificadas · {batchProgress.queued} enfileiradas ·{' '}
                    {batchProgress.already_active} já ativas · {batchProgress.failed} bloqueadas/falhas
                  </span>
                </div>
                {Object.keys(lastBatchFailures).length > 0 && (
                  <p className="field-help">
                    Motivos: {Object.entries(lastBatchFailures)
                      .sort((a, b) => b[1] - a[1])
                      .map(([code, count]) => `${code} (${count})`).join(' · ')}
                  </p>
                )}
                {batchProgress.failed > 0 && (
                  <a
                    href="https://photos-manage.migos.club/?tab=icloud"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Diagnosticar conexão iCloud no Manage
                  </a>
                )}
              </div>
              {page.data.items.length === 0 ? (
                <Empty
                  title="Nenhuma prévia incompleta"
                  description="Todas as variantes cadastradas estão disponíveis nos registros do banco."
                />
              ) : (
                page.data.items.map((finding) => (
                  <div className="row-item" key={finding.asset_id}>
                    <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                      <strong>{finding.filename}</strong>
                      <p>
                        {finding.missing_variants.map((variant) => labels[variant] ?? variant).join(' · ')}
                      </p>
                      {finding.invalid_variants.length > 0 && (
                        <p>
                          <AlertTriangle size={12} /> {finding.invalid_variants.length} registros inválidos
                        </p>
                      )}
                      {finding.job?.error_code && <p>Erro: {finding.job.error_code}</p>}
                      {finding.repair_reason && <p>Fonte: {finding.repair_reason}</p>}
                      {finding.repair_stage && !finding.repair_reason && (
                        <p>Recuperação possível: {finding.repair_stage === 'media_download'
                          ? 'reobter a representação do iCloud'
                          : finding.repair_stage === 'metadata_extract'
                            ? 'processar o original preservado no R2'
                            : 'reconstruir as prévias armazenadas'}</p>
                      )}
                      {finding.job?.status === 'failed' && (
                        <a
                          href={jobLogsUrl(finding.job.job_type, finding.job.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Ver logs do job no Manage
                        </a>
                      )}
                    </div>
                    <div className="failure-actions">
                      {finding.status === 'blocked' ? (
                        <Status value="failed" />
                      ) : finding.status === 'processing' ? (
                        <Status value="running" />
                      ) : finding.status === 'failed' ? (
                        <Status value="failed" />
                      ) : (
                        <Status value="unavailable" />
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          !finding.repairable || repair.isPending || repaired.includes(finding.asset_id)
                        }
                        aria-label={`Reparar prévias de ${finding.filename}`}
                        onClick={() => void retry(finding)}
                      >
                        <RotateCcw size={13} />
                        {repaired.includes(finding.asset_id) ? 'Solicitado' : 'Reparar'}
                      </Button>
                    </div>
                  </div>
                ))
              )}
              <div className="form-actions">
                {cursor && (
                  <Button variant="outline" onClick={() => setCursor(null)}>
                    Primeira página
                  </Button>
                )}
                {page.data.next_cursor && (
                  <Button variant="outline" onClick={() => setCursor(page.data!.next_cursor)}>
                    Próxima página
                  </Button>
                )}
                <Button variant="ghost" onClick={() => void page.refetch()}>
                  <RefreshCw size={13} /> Atualizar
                </Button>
              </div>
            </>
          )
        )}
        {repairError && <ErrorState error={repairError} />}
        <p className="field-help">
          <FileSearch size={13} /> Falhas transitórias com representação recuperável entram na fila
          automaticamente. Fotos sem manifesto ou original no R2, ou com sessão Apple expirada,
          precisam primeiro da recuperação da origem. A auditoria não altera os arquivos Apple.
        </p>
      </div>
    </Dialog>
  );
}
