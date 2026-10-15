import { Check, Fingerprint, Link2, Plus, ShieldCheck, Smartphone, X } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAction, useApi } from '../api/client';
import type { Info, Page } from '../api/types';
import { DetailList, Empty, ErrorState, PageHeader, PrivateImage, Status } from '../components/common';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { date, items, obj, text } from '../lib/format';
import { useUi } from '../lib/store';

export function BridgePage() {
  const [params] = useSearchParams();
  const state = useApi<Info>('/v1/apple-sync/status', 15_000);
  const operations = useApi<Page<Info>>('/v1/apple-sync/operations?limit=50', 15_000);
  const mappings = useApi<Page<Info>>('/v1/apple-sync/mappings?limit=50');
  const action = useAction<Info>();
  const [code, setCode] = useState<Info | null>(null);
  const [asset, setAsset] = useState(params.get('asset') ?? '');
  const [device, setDevice] = useState(''); const [add, setAdd] = useState('');
  const [remove, setRemove] = useState(''); const [approveRemovals, setApproveRemovals] = useState(false);
  const [single, setSingle] = useState(false); const [preview, setPreview] = useState<Info | null>(null);
  const [snapshot, setSnapshot] = useState<Info | null>(null); const [mappingAsset, setMappingAsset] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const devices = items(state.data?.devices).filter((item) => !item.revoked_at);
  const proposal = { asset_id:asset, target_device_id:device,
    add:add.split(',').map((key) => key.trim()).filter(Boolean),
    remove:remove.split(',').map((key) => key.trim()).filter(Boolean),
    approve_removals:approveRemovals, single_asset_test:single, source:'user' };
  return <><PageHeader eyebrow="A ponte com seu iPhone" title="Apple Bridge"
    description="Inventário PhotoKit e operações de keywords com vínculo seguro, revisão e consentimento."
    actions={<Button variant="outline" disabled={action.isPending} onClick={async () => {
      setCode(await action.mutateAsync({url:'/v1/apple-sync/enrollment'}));
    }}><Plus size={14} />Conectar dispositivo</Button>} />
    <div className="notice warning"><ShieldCheck size={15} /><span>{text(state.data?.keyword_write_note ??
      'Pyto v1 é somente leitura. APIs Beta de keywords dependem de validação no dispositivo.')}
      {' '}A classificação na nuvem continua com o Bridge desconectado.</span></div>
    {state.error && <ErrorState error={state.error} retry={() => void state.refetch()} />}
    <div className="two-columns"><section className="panel"><div className="panel-title"><h2>Dispositivos</h2>
      <Smartphone size={16} className="muted" /></div>{!devices.length ? <Empty title="Seu iPhone ainda não está conectado"
        description="Execute doctor e enroll no script Pyto. Gere um código temporário em Conectar dispositivo." /> :
        devices.map((item) => <div key={text(item.id)} className="row-item"><div><strong>{text(item.name)}</strong>
          <p>Último contato: {date(item.last_seen_at,true)}</p><p>{text(obj(item.capabilities).reason)}</p>
          <div className="inline" style={{ marginTop: 7 }}><Status value={obj(item.capabilities).level} />
            <span className="field-help">Escrita {item.write_verified ? 'verificada individualmente' : 'não verificada'}</span></div></div>
          <Button variant="ghost" size="icon" aria-label={`Revogar ${text(item.name)}`} disabled={action.isPending}
            onClick={() => { if (window.confirm('Revogar a credencial deste dispositivo?'))
              action.mutate({url:`/v1/apple-sync/devices/${item.id}/revoke`}); }}><X size={14} /></Button></div>)}
      <div className="panel-section"><h3>Executar pelo Pyto / Shortcuts</h3>
        <pre className="code-block" style={{ marginTop:12 }}>python photo_bridge.py doctor{`\n`}python photo_bridge.py inventory{`\n`}python photo_bridge.py sync --dry-run</pre>
        <p className="field-help" style={{ marginTop:10 }}>O backend retém trabalho pendente. iOS não garante execução contínua com a tela bloqueada.</p></div></section>
      <section className="panel"><div className="panel-title"><h2>Prévia de uma alteração</h2><Fingerprint size={15} className="muted" /></div>
        <div className="stack"><label className="field">Fotografia do catálogo (UUID)<input value={asset} onChange={(e) => {setAsset(e.target.value);setPreview(null);}}
          placeholder="Abra uma foto → Preparar sincronização" maxLength={36} /></label>
          {asset && <div style={{ height:140 }}><PrivateImage src={`/v1/assets/${asset}/media/thumbnail_medium`} alt="Fotografia alvo da alteração" /></div>}
          <label className="field">Dispositivo<select value={device} onChange={(e) => {setDevice(e.target.value);setPreview(null);}}>
            <option value="">Selecione seu iPhone</option>{devices.map((item) => <option key={text(item.id)} value={text(item.id)}>{text(item.name)}</option>)}</select></label>
          <label className="field">Adicionar keywords, separadas por vírgula<input value={add} maxLength={2000}
            onChange={(e) => {setAdd(e.target.value);setPreview(null);}} placeholder="viagem, praia" /></label>
          <label className="field">Remover keywords gerenciadas<input value={remove} maxLength={2000}
            onChange={(e) => {setRemove(e.target.value);setPreview(null);}} placeholder="Opcional" /></label>
          {!!remove.trim() && <label className="checkbox-field">Aprovo somente remoções comprovadamente gerenciadas
            <input type="checkbox" checked={approveRemovals} onChange={(e) => setApproveRemovals(e.target.checked)} /></label>}
          <label className="checkbox-field"><span>Teste individual desta fotografia<small>Bulk write permanece desabilitado até validação.</small></span>
            <input type="checkbox" checked={single} onChange={(e) => setSingle(e.target.checked)} /></label>
          <Button disabled={!asset || !device || action.isPending || (!add.trim() && !remove.trim())}
            onClick={async () => setPreview(await action.mutateAsync({url:'/v1/apple-sync/preview',body:proposal}))}>
            <Fingerprint size={14} />Ver prévia segura</Button>
          {preview && <><DetailList data={{ existing:preview.before,add:preview.add,remove:preview.remove,
            managed:preview.managed_keywords,mapping:preview.mapping_status,
            capability:preview.capability,write:preview.write_available ? 'Disponível para teste aprovado' : 'Indisponível; operação ficará pendente',
          }} labels={{existing:'Keywords atuais',add:'Adicionar',remove:'Remover',managed:'Gerenciadas',mapping:'Vínculo',capability:'Capacidade',write:'Escrita'}} />
            <Button variant="outline" disabled={action.isPending} onClick={async () => {
              await action.mutateAsync({url:'/v1/apple-sync/operations',body:{...proposal,idempotency_key:crypto.randomUUID(),approve:false}});
              setPreview(null);useUi.getState().notify('Operação criada aguardando aprovação.');
            }}><Plus size={14} />Criar operação para aprovação</Button></>}
        </div></section></div>
    <section className="panel" style={{marginTop:20}}><div className="panel-title"><h2>Operações de keywords</h2><span className="muted">Aprovação manual</span></div>
      {operations.error ? <ErrorState error={operations.error} /> : !operations.data?.items.length ?
        <p className="muted">Nenhuma operação criada. Nenhuma modificação é enviada automaticamente.</p> : operations.data.items.map((operation) =>
          <div className="row-item" key={text(operation.id)}><div><strong>{text(operation.id).slice(0,8)} · {text(operation.asset_id).slice(0,8)}</strong>
            <p>{date(operation.created_at,true)} · {text(operation.last_error)}</p>
            <p>Adicionar: {text(obj(operation.payload).add)} · remover: {text(obj(operation.payload).remove)}</p></div>
            <div className="inline"><Status value={operation.status} />
              {operation.status === 'awaiting_approval' && <Button variant="outline" size="sm" disabled={action.isPending}
                onClick={() => { if(window.confirm('Aprovar esta operação individual após revisar o alvo e as keywords?'))
                  action.mutate({url:`/v1/apple-sync/operations/${operation.id}/approve`}); }}><Check size={12} />Aprovar</Button>}
              {!['completed','cancelled'].includes(text(operation.status)) && <Button variant="ghost" size="icon" aria-label="Cancelar operação"
                disabled={action.isPending} onClick={() => action.mutate({url:`/v1/apple-sync/operations/${operation.id}/cancel`})}><X size={14} /></Button>}
            </div></div>)}</section>
    <section className="panel" style={{marginTop:20}}><div className="panel-title"><h2>Revisão de correspondências</h2><Link2 size={15} /></div>
      <p className="muted" style={{marginBottom:15}}>IDs iCloud e PhotoKit não são intercambiáveis. Confira nome, data e dimensões antes de confirmar um vínculo.</p>
      {!mappings.data?.items.length ? <p className="field-help">Envie um inventário pelo Bridge para revisar correspondências.</p> :
        mappings.data.items.map((item) => <div className="row-item" key={text(item.id)}><div><strong>{text(obj(item.payload).filename)}</strong>
          <p>{date(obj(item.payload).captured_at,true)} · {text(obj(item.payload).width)} × {text(obj(item.payload).height)}</p>
          <p>Asset: {text(item.asset_id)} · snapshot {text(item.id).slice(0,8)}</p></div>
          <Button variant="outline" size="sm" onClick={() => {setSnapshot(item);setMappingAsset(typeof item.asset_id === 'string' ? item.asset_id : '');setConfirmed(false);}}>Revisar</Button></div>)}
    </section>
    <Dialog open={code !== null} onOpenChange={(open) => !open && setCode(null)} title="Código de enrollment"
      description="Uso único, válido por 10 minutos. Digite no Pyto; não compartilhe este código.">
      <pre className="code-block">{text(code?.code)}</pre><p className="field-help" style={{marginTop:12}}>Expira em {date(code?.expires_at,true)}.
        A credencial do dispositivo será armazenada somente no iPhone.</p>
    </Dialog>
    <Dialog open={snapshot !== null} onOpenChange={(open) => !open && setSnapshot(null)} title="Confirmar vínculo de fotografia">
      {snapshot && <div className="stack"><DetailList data={obj(snapshot.payload)} />
        <label className="field">UUID da fotografia correspondente<input value={mappingAsset} onChange={(e) => setMappingAsset(e.target.value)} maxLength={36} /></label>
        {mappingAsset && <div style={{height:180}}><PrivateImage src={`/v1/assets/${mappingAsset}/media/thumbnail_medium`} alt="Fotografia a vincular" /></div>}
        <label className="checkbox-field"><span>Verifiquei que ambos representam exatamente a mesma fotografia</span>
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /></label>
        <Button disabled={!confirmed || !mappingAsset || action.isPending} onClick={async () => {
          await action.mutateAsync({url:'/v1/apple-sync/mappings/confirm',body:{asset_id:mappingAsset,snapshot_id:snapshot.id,confirm:true}});
          setSnapshot(null); useUi.getState().notify('Correspondência confirmada e auditada.');
        }}>Confirmar correspondência</Button></div>}
    </Dialog>
  </>;
}
