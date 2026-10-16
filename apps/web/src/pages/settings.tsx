import { useEffect, useState } from 'react';
import { Download, Save, ShieldCheck } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { apiUrl, request, useAction, useApi } from '../api/client';
import type { Capabilities, Info } from '../api/types';
import { DetailList, ErrorState, PageHeader, Skeleton, Status } from '../components/common';
import { Button } from '../components/ui/button';
import { useUi } from '../lib/store';

const schema = z.object({
  sensitive_tags_visible: z.boolean(), gpu_enabled: z.boolean(),
  batch_size: z.number().int().min(1).max(128), worker_concurrency: z.number().int().min(1).max(32),
  joytag_threshold: z.number().min(0).max(1), joytag_max_tags: z.number().int().min(1).max(1000),
  ingestion_interval_minutes: z.number().int().min(5).max(10080),
  ingestion_import_limit: z.number().int().min(1).max(1_000_000),
  max_download_bytes: z.number().int().min(1024).max(1024 ** 3),
  max_run_download_bytes: z.number().int().min(1024).max(1024 ** 4),
  max_gpu_concurrency: z.number().int().min(1).max(16),
  gpu_max_assets_per_run: z.number().int().min(1).max(100000),
  gpu_max_cost_per_run: z.number().min(0).max(1000), gpu_daily_budget: z.number().min(0).max(1000),
  gpu_monthly_budget: z.number().min(0).max(10000),
  temporary_retention_hours: z.number().int().min(1).max(8760),
  apple_keyword_sync_mode: z.enum(['manual', 'disabled']),
});
type Form = z.infer<typeof schema>;
type Numeric = Exclude<keyof Form, 'sensitive_tags_visible'|'gpu_enabled'|'apple_keyword_sync_mode'>;
const groups: { id: string; label: string; description: string;
  fields: { key: Numeric; label: string; step?: string; help?: string }[] }[] = [
  {id:'ai',label:'Inteligência',description:'Controle a análise real e os limites de cada execução.',fields:[
    {key:'batch_size',label:'Imagens por lote'},{key:'worker_concurrency',label:'Concorrência de workers'},
    {key:'joytag_threshold',label:'Confiança mínima JoyTag (0–1)',step:'0.01'},
    {key:'joytag_max_tags',label:'Máximo de tags por fotografia'},
  ]},
  {id:'ingestion',label:'Ingestão',description:'Comece pequeno. Alterar limites não inicia uma importação.',fields:[
    {key:'ingestion_interval_minutes',label:'Intervalo de sincronização (min)'},
    {key:'ingestion_import_limit',label:'Limite padrão de importação'},
    {key:'max_download_bytes',label:'Máximo por representação (bytes)'},
    {key:'max_run_download_bytes',label:'Máximo por execução (bytes)'},
    {key:'temporary_retention_hours',label:'Retenção de temporários (horas)'},
  ]},
  {id:'budget',label:'GPU e orçamento',description:'Estimativas locais não são um teto garantido de faturamento.',fields:[
    {key:'max_gpu_concurrency',label:'Jobs GPU simultâneos'},
    {key:'gpu_max_assets_per_run',label:'Fotografias por execução GPU'},
    {key:'gpu_max_cost_per_run',label:'Custo estimado máximo por lote (USD)',step:'0.01'},
    {key:'gpu_daily_budget',label:'Orçamento diário estimado (USD)',step:'0.01'},
    {key:'gpu_monthly_budget',label:'Orçamento mensal estimado (USD)',step:'0.01'},
  ]},
];
export function SettingsPage() {
  const [tab,setTab] = useState('ai'); const [exportKind,setExportKind] = useState('manifest');
  const [exportFormat,setExportFormat] = useState('json'); const [diagnosing,setDiagnosing] = useState(false);
  const query = useApi<Info>('/v1/settings'); const cap = useApi<Capabilities>('/v1/system/capabilities');
  const action = useAction('/v1/settings','PATCH');
  const form = useForm<Form>({resolver:zodResolver(schema)});
  useEffect(() => { if(query.data) {
    const fields = Object.fromEntries(Object.keys(schema.shape).map((key) => [key,query.data![key]]));
    form.reset(fields as Form,{keepDirtyValues:true});
  } },[query.data,form]);
  const group = groups.find((value) => value.id === tab);
  async function downloadDiagnostics() {
    setDiagnosing(true);
    try {
      const data = await request<Info>('/v1/system/diagnostics');
      const blob = new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
      anchor.href=url;anchor.download='photointel-diagnostico.json';anchor.click();URL.revokeObjectURL(url);
    } catch(error) { useUi.getState().notify((error as Error).message,'error'); }
    finally {setDiagnosing(false);}
  }
  return <><PageHeader eyebrow="Seu ambiente, suas regras" title="Configurações"
    description="Privacidade, ingestão e limites operacionais em um único lugar."
    actions={<Button onClick={form.handleSubmit(async (body) => {
      await action.mutateAsync({body});useUi.getState().notify('Configurações salvas.');
    })} disabled={action.isPending || !query.data}><Save size={14} />Salvar alterações</Button>} />
    {query.error ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : query.isPending ? <Skeleton /> : <>
      <div className="settings-nav">{[...groups.map(({id,label}) => ({id,label})),
        {id:'privacy',label:'Privacidade'},{id:'export',label:'Exportar'},{id:'system',label:'Diagnóstico'}].map((item) =>
          <button key={item.id} className={tab===item.id?'active':''} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
      <section className="panel settings-section">
        {group && <><h2>{group.label}</h2><p className="muted">{group.description}</p>
          <div className="form-grid">{group.fields.map((field) => <label className="field" key={field.key}>{field.label}
            <input type="number" step={field.step??'1'} {...form.register(field.key,{valueAsNumber:true})} />
            {form.formState.errors[field.key] && <span className="field-error">Valor fora do intervalo permitido.</span>}
            {field.help && <span className="field-help">{field.help}</span>}</label>)}</div>
          {tab==='ai' && <div className="panel-section"><DetailList data={{
            joytag:query.data.joytag_model_id,joytag_revision:query.data.joytag_model_revision,
            siglip:query.data.siglip_model_id,siglip_revision:query.data.siglip_model_revision,
            dimension:query.data.siglip_embedding_dimension,
          }} labels={{joytag:'JoyTag',joytag_revision:'Revisão',siglip:'SigLIP 2',siglip_revision:'Revisão',dimension:'Dimensão'}} />
            <p className="field-help">Alterações de checkpoint são operacionais e exigem reindexação compatível.</p></div>}
          {tab==='budget' && <><label className="checkbox-field" style={{marginTop:20}}><span>Habilitar processamento GPU
            <small>Somente após configurar Modal, credenciais e controles de billing do provedor.</small></span>
            <input type="checkbox" {...form.register('gpu_enabled')} /></label>
            <div className="notice warning" style={{marginTop:15}}><ShieldCheck size={15} />
              Instalação e testes comuns não consomem GPU. Ativar esta configuração permite que os jobs aprovados enviem fotografias ao adapter configurado.</div></>}
        </>}
        {tab==='privacy' && <><h2>Privacidade e sincronização</h2><p className="muted">Seus dados permanecem privados por padrão.</p>
          <label className="checkbox-field"><span>Exibir classificações sensíveis
            <small>Opt-in separado para exibição e filtros. Não altera os resultados brutos privados.</small></span>
            <input type="checkbox" {...form.register('sensitive_tags_visible')} /></label>
          <label className="field" style={{marginTop:23}}>Política de keywords Apple
            <select {...form.register('apple_keyword_sync_mode')}><option value="manual">Aprovação manual</option><option value="disabled">Desativada</option></select>
            <span className="field-help">Keywords existentes são preservadas. Escrita depende de PhotoKit verificado.</span></label>
          <div className="notice" style={{marginTop:23}}><ShieldCheck size={15} />Sem analytics de terceiros,
            compartilhamento público ou cache de fotografias no service worker.</div></>}
        {tab==='export' && <><h2>Portabilidade dos seus dados</h2><p className="muted">Exporte a inteligência do catálogo.
          Isso não é um backup dos originais no iCloud.</p><div className="form-grid"><label className="field">Conteúdo
            <select value={exportKind} onChange={(e) => setExportKind(e.target.value)}>
              <option value="manifest">Manifesto de fotografias</option><option value="taxonomy">Taxonomia</option>
              <option value="tags">Tags e procedência</option><option value="inference">Resultados de inferência</option>
              <option value="apple_sync">Auditoria de Apple Sync</option><option value="audit">Eventos de auditoria</option></select></label>
            <label className="field">Formato<select value={exportFormat} onChange={(e) => setExportFormat(e.target.value)}>
              <option value="json">JSON</option><option value="csv">CSV</option></select></label></div>
          <Button variant="outline" asChild style={{marginTop:20}}><a href={apiUrl(`/v1/system/export?kind=${exportKind}&format=${exportFormat}`)}
            download><Download size={14} />Exportar metadata</a></Button>
          <div className="panel-section"><h3>Backup PostgreSQL</h3><p className="muted" style={{margin:'10px 0'}}>Execute no terminal seguro.
            Os dumps devem ser guardados em armazenamento privado.</p><pre className="code-block">make backup{`\n`}make restore-test</pre></div></>}
        {tab==='system' && <><h2>Diagnóstico e capacidades</h2><p className="muted">Disponibilidade explícita,
          sem supor que credenciais e hardware já foram verificados.</p>
          <DetailList data={{environment:query.data.app_env,storage:query.data.storage_backend,inference:query.data.inference_backend,
            representation:query.data.download_representation,fallback:query.data.allow_original_fallback?'Permitido com limites':'Desabilitado'}}
            labels={{environment:'Ambiente',storage:'Armazenamento',inference:'Adapter IA',representation:'Representação iCloud',fallback:'Fallback original'}} />
          {cap.data && Object.entries(cap.data).map(([key,value]) => <div className="row-item" key={key}>
            <div><strong>{key.replaceAll('_',' ')}</strong><p>{value.reason}</p></div><Status value={value.state} /></div>)}
          <Button variant="outline" onClick={() => void downloadDiagnostics()} disabled={diagnosing} style={{marginTop:20}}>
            <Download size={14} />Exportar diagnóstico sem segredos</Button></>}
      </section>
      {!!Object.keys(form.formState.errors).length && <p className="field-error" style={{marginTop:15}}>Revise os valores inválidos nas abas de configuração.</p>}
    </>}
  </>;
}
