import { Cloud, Info, LockKeyhole, Pause, Play, Terminal } from 'lucide-react';
import { useState } from 'react';
import { useAction, useApi } from '../api/client';
import type { Info as InfoData, Page } from '../api/types';
import { DetailList, Empty, ErrorState, PageHeader, Skeleton, Status } from '../components/common';
import { Button } from '../components/ui/button';
import { date, number, obj, text } from '../lib/format';
import { useUi } from '../lib/store';

export function ICloudPage() {
  const state = useApi<InfoData>('/v1/ingestion/status', 15_000);
  const runs = useApi<Page<InfoData>>('/v1/ingestion/runs?limit=30', 15_000);
  const settings = useApi<InfoData>('/v1/settings');
  const libraries = useApi<Page<InfoData>>('/v1/libraries');
  const action = useAction(); const [limit, setLimit] = useState(100);
  const [source, setSource] = useState('icloud'); const [library, setLibrary] = useState('');
  const [fullScan, setFullScan] = useState(false); const [expanded, setExpanded] = useState(false);
  const local = ['test', 'development'].includes(String(settings.data?.app_env));
  const auth = obj(state.data?.authentication); const last = obj(state.data?.last_run);
  const canStart = source === 'fixture' ? local : state.data?.enabled === true;
  return <><PageHeader eyebrow="Originais sempre preservados" title="Sincronização iCloud"
    description="O servidor importa representações controladas e continua funcionando com o iPhone desconectado."
    actions={<Button variant="outline" disabled={action.isPending || !state.data}
      onClick={() => action.mutate({ url: `/v1/ingestion/${state.data?.paused ? 'resume' : 'pause'}` })}>
      {state.data?.paused ? <Play size={14} /> : <Pause size={14} />}
      {state.data?.paused ? 'Retomar agendamento' : 'Pausar agendamento'}</Button>} />
    {state.error && <ErrorState error={state.error} retry={() => void state.refetch()} />}
    <div className="notice"><LockKeyhole size={15} /><span>Sua senha Apple é digitada somente no terminal seguro,
      nunca nesta interface. Importações não alteram nem excluem originais.</span></div>
    <div className="two-columns"><section className="panel"><div className="panel-title"><h2>Conexão da biblioteca</h2>
      <Cloud size={16} className="muted" /></div>{state.isPending ? <Skeleton count={1} /> :
      <><div className="inline between" style={{ marginBottom: 15 }}><strong style={{ fontSize: 12 }}>Sessão Apple</strong>
        <Status value={auth.state ?? auth.status ?? 'unknown'} /></div>
        {!!auth.reason && <p className="muted" style={{ marginBottom: 14 }}>{text(auth.reason)}</p>}
        <DetailList data={{ library: state.data?.selected_library, enabled: state.data?.enabled ? 'Habilitada' : 'Não configurada',
          schedule: state.data?.paused ? 'Pausado' : `A cada ${text(state.data?.interval_minutes)} min`,
          last: date(state.data?.last_successful_sync,true), next: date(state.data?.next_scheduled_sync,true),
        }} labels={{library:'Biblioteca',enabled:'Ingestão',schedule:'Agendamento',last:'Último sucesso',next:'Próxima execução'}} />
      </>}
      <div className="panel-section"><h3>Autenticação pelo iPhone</h3><p className="muted" style={{ margin: '10px 0' }}>
        Abra o terminal do Codespaces ou conecte por SSH ao host. Digite a senha e o código 2FA quando solicitados.</p>
        <pre className="code-block">make icloud-auth{`\n`}make icloud-verify{`\n`}make icloud-libraries</pre>
        <p className="field-help" style={{ marginTop: 10 }}><Terminal size={11} style={{ display:'inline' }} />
          Sessão expirada? Execute make icloud-auth novamente. Consulte ICLOUD_SETUP.md para o procedimento completo.</p></div>
    </section>
    <section className="panel"><div className="panel-title"><h2>Importação controlada</h2><Info size={15} className="muted" /></div>
      <div className="stack"><label className="field">Fonte<select value={source} onChange={(e) => setSource(e.target.value)}>
        <option value="icloud">Apple iCloud Photos</option>{local && <option value="fixture">Imagens sintéticas locais (desenvolvimento)</option>}</select></label>
        <label className="field">Biblioteca<select value={library} onChange={(e) => setLibrary(e.target.value)}>
          <option value="">Biblioteca configurada no servidor</option>{libraries.data?.items.map((item) =>
            <option key={text(item.id)} value={text(item.id)}>{text(item.name)}</option>)}</select></label>
        <label className="field">Limite desta execução<input type="number" min="1" max="10000" value={limit}
          onChange={(e) => setLimit(Number(e.target.value))} /><span className="field-help">Comece com até 100.
            Expansões respeitam os limites de bytes e de processamento configurados.</span></label>
        <label className="checkbox-field"><span>Reconciliação mais profunda<small>Não interpreta uma falha de varredura como exclusão.</small></span>
          <input type="checkbox" checked={fullScan} onChange={(e) => setFullScan(e.target.checked)} /></label>
        {limit > Number(state.data?.import_limit ?? 100) && <label className="checkbox-field"><span>Confirmo ampliar esta execução</span>
          <input type="checkbox" checked={expanded} onChange={(e) => setExpanded(e.target.checked)} /></label>}
        {!canStart && <p className="field-help">Configure ICLOUD_ENABLED e autentique a sessão no host para habilitar a importação real.</p>}
        <Button disabled={!canStart || action.isPending || limit < 1 || limit > 10000 ||
          (limit > Number(state.data?.import_limit ?? 100) && !expanded)} onClick={async () => {
          await action.mutateAsync({url:'/v1/ingestion/start', body:{ source, limit,
            ...(library ? {library_id:library} : {}), full_scan:fullScan, confirm_expansion:expanded }});
          useUi.getState().notify('Importação adicionada à fila. Acompanhe no Processamento.');
        }}><Play size={14} />{source === 'fixture' ? 'Importar fixtures locais' : `Importar até ${limit} fotografias`}</Button>
      </div></section></div>
    <section className="panel" style={{ marginTop: 20 }}><div className="panel-title"><h2>Histórico de sincronização</h2>
      <span className="muted">{last.status ? text(last.status) : 'Sem execuções'}</span></div>
      {runs.error ? <ErrorState error={runs.error} /> : runs.isPending ? <Skeleton count={2} /> :
        !runs.data.items.length ? <Empty title="Pronto para a primeira importação" description="As execuções e falhas aparecerão aqui após iniciar um lote." /> :
          runs.data.items.map((run) => <div className="row-item" key={text(run.id)}><div><strong>{date(run.started_at,true)}</strong>
            <p>{number(run.discovered ?? run.assets_discovered)} descobertas · {number(run.imported ?? run.new_assets)} novas ·
              {' '}{number(run.failed ?? run.failed_downloads)} falhas · {number(run.bytes_transferred)} bytes</p>
            {!!run.error_code && <p>{text(run.error_code)} · {text(run.error_details)}</p>}</div><Status value={run.status} /></div>)}
    </section></>;
}
