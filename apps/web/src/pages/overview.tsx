import {
  Activity,
  ArrowRight,
  Aperture,
  CheckCheck,
  Cloud,
  Images,
  Layers,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useApi } from '../api/client';
import type { Capabilities, Info, Page, Asset } from '../api/types';
import { ErrorState, PageHeader, PrivateImage, Skeleton, Status } from '../components/common';
import { Button } from '../components/ui/button';
import { SetupStatusPanel } from '../components/setup-status';
import { bytes, date, number, obj, text } from '../lib/format';

export function Overview() {
  const stats = useApi<Info>('/v1/system/statistics', 15_000);
  const system = useApi<Info>('/v1/system/status', 30_000);
  const storage = useApi<Info>('/v1/system/storage', 60_000);
  const costs = useApi<Info>('/v1/system/costs', 60_000);
  const photos = useApi<Page<Asset>>('/v1/assets?limit=6&sort=added_desc');
  const capabilities = obj(system.data?.capabilities) as Capabilities;
  const ingestion = obj(system.data?.ingestion);
  const jobs = obj(stats.data?.job_counts);
  const values = stats.data ?? {};
  return (
    <>
      <PageHeader
        eyebrow="Seu workspace privado"
        title="Um novo olhar para o seu acervo."
        description="Encontre o que importa. Acompanhe cada etapa, do iCloud à inteligência visual."
        actions={
          <Button asChild variant="outline">
            <Link to="/icloud">
              <Cloud size={14} />
              Sincronizar iCloud
            </Link>
          </Button>
        }
      />
      {stats.error && <ErrorState error={stats.error} retry={() => void stats.refetch()} />}
      <SetupStatusPanel compact />
      <div className="overview-intro">
        <div>
          <p className="eyebrow">PHOTO INTELLIGENCE CLOUD</p>
          <h2>Suas memórias. Mais fáceis de encontrar.</h2>
          <p>
            Busque por uma ideia em português, explore palavras-chave e redescubra fotografias. As prévias são
            privadas e os originais permanecem no iCloud.
          </p>
          <Button asChild>
            <Link to="/search">
              <Search size={14} />
              Explorar busca inteligente
              <ArrowRight size={14} />
            </Link>
          </Button>
        </div>
        <div className="overview-mark">
          <Aperture size={52} strokeWidth={1} />
        </div>
      </div>
      {stats.isPending ? (
        <Skeleton />
      ) : (
        <div className="metrics">
          {[
            {
              title: 'Fotografias no catálogo',
              value: values.total_assets,
              icon: Images,
              caption: `${number(values.indexed_photos)} com inteligência indexada`,
            },
            {
              title: 'Prévias disponíveis',
              value: values.processed_assets,
              icon: CheckCheck,
              caption: 'Armazenamento privado e autorizado',
            },
            {
              title: 'Processamento pendente',
              value: values.pending_processing,
              icon: Layers,
              caption: `${number(jobs.running ?? 0)} jobs em execução`,
            },
            {
              title: 'Jobs que precisam de atenção',
              value: jobs.failed ?? 0,
              icon: Activity,
              caption: 'Falhas preservadas para inspeção',
            },
          ].map(({ title, value, icon: Icon, caption }) => (
            <div className="metric" key={title}>
              <div className="metric-label">
                {title}
                <Icon size={14} />
              </div>
              <div className="metric-value">{number(value)}</div>
              <p className="metric-caption">{caption}</p>
            </div>
          ))}
        </div>
      )}
      <div className="two-columns">
        <section className="panel">
          <div className="panel-title">
            <h2>Estado do seu acervo</h2>
            <ShieldCheck size={15} className="muted" />
          </div>
          <div className="row-list">
            <div className="row-item">
              <div>
                <strong>iCloud Photos</strong>
                <p>Última sincronização: {date(ingestion.last_successful_sync, true)}</p>
              </div>
              <Status value={obj(ingestion.authentication).state ?? 'not_configured'} />
            </div>
            <div className="row-item">
              <div>
                <strong>Inteligência visual</strong>
                <p>JoyTag e embeddings SigLIP 2, com revisão de modelo</p>
              </div>
              <Status value={capabilities.gpu_inference?.state ?? 'not_configured'} />
            </div>
            <div className="row-item">
              <div>
                <strong>Armazenamento de prévias</strong>
                <p>{bytes(storage.data?.total_bytes)} registrados no catálogo</p>
              </div>
              <Link to="/settings">
                <ArrowRight size={16} />
              </Link>
            </div>
            <div className="row-item">
              <div>
                <strong>Estimativa de processamento</strong>
                <p>USD {number(costs.data?.estimated_monthly_cost)} em resultados retidos neste mês</p>
                <p>
                  Reserva estimada: USD {number(costs.data?.reserved_monthly_estimate)} · não é limite de
                  billing
                </p>
              </div>
              <Link to="/jobs">
                <ArrowRight size={16} />
              </Link>
            </div>
          </div>
        </section>
        <section className="panel">
          <div className="panel-title">
            <h2>Próximos passos</h2>
            <Sparkles size={15} className="muted" />
          </div>
          <div className="row-list">
            <Link to="/icloud" className="row-item">
              <div>
                <strong>Conectar sua biblioteca</strong>
                <p>Autentique no terminal e importe primeiro até 100 fotos.</p>
              </div>
              <ArrowRight size={16} />
            </Link>
            <Link to="/jobs" className="row-item">
              <div>
                <strong>Acompanhar o processamento</strong>
                <p>Fila durável, erros e progresso registrados de verdade.</p>
              </div>
              <ArrowRight size={16} />
            </Link>
            <Link to="/bridge" className="row-item">
              <div>
                <strong>Preparar o Apple Bridge</strong>
                <p>Revise os vínculos e as capacidades do seu iPhone.</p>
              </div>
              <ArrowRight size={16} />
            </Link>
          </div>
        </section>
      </div>
      <section className="panel" style={{ marginTop: 22 }}>
        <div className="panel-title">
          <h2>Adicionadas recentemente</h2>
          <Button asChild variant="ghost" size="sm">
            <Link to="/library">
              Ver biblioteca <ArrowRight size={13} />
            </Link>
          </Button>
        </div>
        {photos.data?.items.length ? (
          <div className="photo-strip" style={{ marginTop: 0 }}>
            {photos.data.items.map((photo) => (
              <Link
                key={photo.id}
                to={`/library?photo=${photo.id}`}
                style={{ width: 150, height: 110, flexShrink: 0, borderRadius: 5, overflow: 'hidden' }}
              >
                <PrivateImage src={photo.thumbnail_url} alt={photo.filename} />
              </Link>
            ))}
          </div>
        ) : (
          <p className="muted">As fotografias aparecerão aqui após a primeira importação.</p>
        )}
      </section>
      <button
        type="button"
        onClick={() => {
          document.dispatchEvent(new Event('photointel:enable-notifications'));
        }}
      >
        Ativar notificações
      </button>
      {system.error && <ErrorState error={system.error} retry={() => void system.refetch()} />}
      {system.data?.environment === 'test' && (
        <div className="notice warning" style={{ marginTop: 18 }}>
          <ShieldCheck size={15} />
          <span>
            Ambiente de teste. Inferências determinísticas de testes não representam análise real de sua
            biblioteca.
          </span>
        </div>
      )}
      <span className="sr-only">API: {text(system.data?.api)}</span>
    </>
  );
}
