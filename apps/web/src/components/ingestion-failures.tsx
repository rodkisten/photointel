import { Archive, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useAction, useApi } from '../api/client';
import type { IngestionFailure } from '../api/operations';
import type { Page } from '../api/types';
import { date } from '../lib/format';
import { useUi } from '../lib/store';
import { Empty, ErrorState, Skeleton, Status } from './common';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

const categories: Record<string, string> = {
  transient_network_error: 'Falha temporária de rede', authentication_required: 'Sessão Apple requer autenticação',
  rate_limited: 'Limite temporário do provedor', remote_asset_unavailable: 'Arquivo indisponível no iCloud',
  corrupt_media: 'Representação corrompida', invalid_representation: 'Representação inválida',
  storage_error: 'Falha no armazenamento privado', permanent_failure: 'Falha permanente',
};
export function IngestionFailures() {
  const [status, setStatus] = useState('failed');
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<IngestionFailure | null>(null);
  const [reason, setReason] = useState('');
  const failures = useApi<Page<IngestionFailure>>(`/v1/ingestion/failures?status=${status}&limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 15_000);
  const action = useAction();
  return <section className="panel" style={{ marginTop: 20 }} aria-label="Falhas por fotografia">
    <div className="panel-title"><h2>Falhas por fotografia</h2><select aria-label="Estado das falhas" className="input" style={{ width: 160 }}
      value={status} onChange={(event) => { setStatus(event.target.value); setCursor(null); }}>
      <option value="failed">Falhas</option><option value="retrying">Novas tentativas</option><option value="quarantined">Quarentena</option></select></div>
    <p className="muted" style={{ marginBottom: 14 }}>Uma falha não bloqueia as demais fotografias. Quarentena preserva o registro e não exclui o original.</p>
    {failures.error ? <ErrorState error={failures.error} retry={() => void failures.refetch()} /> : failures.isPending ? <Skeleton count={2} /> :
      !failures.data?.items.length ? <Empty title="Nenhuma falha neste estado" description="Os erros de download e as tentativas ficam preservados por fotografia." /> :
        failures.data.items.map((failure) => <div className="row-item failure-row" key={failure.asset_id}>
          <div><strong>{failure.filename}</strong><p>{categories[failure.failure_category ?? ''] ?? failure.failure_category ?? 'Falha registrada'}
            {' · '}tentativa {failure.attempts}/{failure.maximum_attempts}</p>
            <p>{failure.error_code}{failure.updated_at ? ` · ${date(failure.updated_at, true)}` : ''}</p></div>
          <div className="failure-actions"><Status value={failure.status} />
            <Button variant="outline" size="sm" disabled={action.isPending || failure.status === 'retrying'}
              aria-label={`Repetir download de ${failure.filename}`} onClick={async () => {
                await action.mutateAsync({url: `/v1/ingestion/assets/${failure.asset_id}/retry`,
                  body: {reason: 'Nova tentativa manual'}});
                useUi.getState().notify('Tentativa adicionada à fila somente para esta fotografia.');
              }}><RefreshCw size={12} />Repetir</Button>
            {failure.status !== 'quarantined' && <Button variant="ghost" size="sm" disabled={action.isPending}
              aria-label={`Colocar ${failure.filename} em quarentena`} onClick={() => { setSelected(failure); setReason(''); }}>
              <Archive size={12} />Quarentena</Button>}
          </div></div>)}
    {(cursor || failures.data?.next_cursor) && <div className="form-actions">
      {cursor && <Button variant="ghost" onClick={() => setCursor(null)}>Primeira página</Button>}
      {failures.data?.next_cursor && <Button variant="outline" onClick={() => setCursor(failures.data!.next_cursor)}>Próxima página</Button>}</div>}
    <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)} title="Colocar fotografia em quarentena"
      description="Suspende novas tentativas automáticas desta fotografia. O catálogo, o histórico e o original permanecem preservados.">
      <p style={{ marginBottom: 16 }}>{selected?.filename}</p>
      <label className="field">Motivo<input maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <div className="form-actions"><Button variant="outline" onClick={() => setSelected(null)}>Cancelar</Button>
        <Button disabled={action.isPending || !reason.trim()} onClick={async () => {
          await action.mutateAsync({url: `/v1/ingestion/assets/${selected!.asset_id}/quarantine`, body: {reason: reason.trim()}});
          setSelected(null); useUi.getState().notify('Fotografia preservada em quarentena.');
        }}>Confirmar quarentena</Button></div>
    </Dialog>
  </section>;
}
