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
  job: PreviewJob | null;
};

type PreviewAuditPage = {
  total_assets: number;
  total_issues: number;
  items: PreviewFinding[];
  next_cursor: string | null;
  verification: 'catalog_metadata';
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
  const repair = useAction<{ created: boolean; message: string }>();

  async function retry(finding: PreviewFinding) {
    setRepairError(null);
    try {
      const result = await repair.mutateAsync({
        url: `/v1/jobs/assets/${finding.asset_id}/preview/repair`,
      });
      setRepaired((items) => items.includes(finding.asset_id) ?
        items : [...items, finding.asset_id]);
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

  return <Dialog open onOpenChange={(value) => !value && onClose()}
    title="Auditoria de thumbnails e previews"
    description="Busca em todo o catálogo por variantes ausentes, inválidas ou jobs com falha. Nenhum job é criado durante a busca.">
    <div className="stack" style={{ maxHeight: '65vh', overflowY: 'auto' }}>
      {page.error ? <ErrorState error={page.error} retry={() => void page.refetch()} /> :
        page.isPending ? <Skeleton count={3} /> : page.data && <>
          <div className="metrics">
            <div className="metric"><div className="metric-label">Fotos analisadas</div>
              <div className="metric-value">{page.data.total_assets.toLocaleString('pt-BR')}</div></div>
            <div className="metric"><div className="metric-label">Prévias incompletas</div>
              <div className="metric-value">{page.data.total_issues.toLocaleString('pt-BR')}</div></div>
          </div>
          <p className="field-help">Auditoria dos registros do catálogo, inclusive falhas sem job recente.
            Não verifica objetos do R2 que ainda aparecem como disponíveis no banco.</p>
          {page.data.items.length === 0 ? <Empty title="Nenhuma prévia incompleta"
            description="Todas as variantes cadastradas estão disponíveis nos registros do banco." /> :
            page.data.items.map((finding) =>
              <div className="row-item" key={finding.asset_id}>
                <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                  <strong>{finding.filename}</strong>
                  <p>{finding.missing_variants.map((variant) => labels[variant] ?? variant).join(' · ')}</p>
                  {finding.invalid_variants.length > 0 && <p>
                    <AlertTriangle size={12} /> {finding.invalid_variants.length} registros inválidos
                  </p>}
                  {finding.job?.error_code && <p>Erro: {finding.job.error_code}</p>}
                  {finding.job?.status === 'failed' && <a
                    href={jobLogsUrl(finding.job.job_type, finding.job.id)}
                    target="_blank" rel="noopener noreferrer">Ver logs do job no GCP</a>}
                </div>
                <div className="failure-actions">
                  {finding.status === 'blocked' ? <Status value="failed" /> :
                    finding.status === 'processing' ? <Status value="running" /> :
                    finding.status === 'failed' ? <Status value="failed" /> :
                    <Status value="unavailable" />}
                  <Button size="sm" variant="outline"
                    disabled={!finding.repairable || repair.isPending ||
                      repaired.includes(finding.asset_id)}
                    aria-label={`Reparar prévias de ${finding.filename}`}
                    onClick={() => void retry(finding)}>
                    <RotateCcw size={13} />
                    {repaired.includes(finding.asset_id) ? 'Solicitado' : 'Reparar'}
                  </Button>
                </div>
              </div>
            )}
          <div className="form-actions">
            {cursor && <Button variant="outline" onClick={() => setCursor(null)}>
              Primeira página</Button>}
            {page.data.next_cursor && <Button variant="outline"
              onClick={() => setCursor(page.data!.next_cursor)}>
              Próxima página</Button>}
            <Button variant="ghost" onClick={() => void page.refetch()}>
              <RefreshCw size={13} /> Atualizar</Button>
          </div>
        </>}
      {repairError && <ErrorState error={repairError} />}
      <p className="field-help"><FileSearch size={13} /> Os itens bloqueados por falha
        de ingestão precisam ser tratados na origem antes do reparo da prévia.</p>
    </div>
  </Dialog>;
}
