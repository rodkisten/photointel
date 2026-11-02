import { ArrowRight, CircleCheck, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useApi } from '../api/client';
import type { SetupStatus } from '../api/operations';
import { date } from '../lib/format';
import { localPath } from '../lib/safe-path';
import { ErrorState, Skeleton, Status } from './common';
import { Button } from './ui/button';

export function SetupStatusPanel({ compact = false }: { compact?: boolean }) {
  const setup = useApi<SetupStatus>('/v1/setup/status', 30_000);
  const checks = setup.data?.checks ?? [];
  const next = setup.data?.next_action;
  const href = localPath(next?.href);
  return (
    <section className="panel setup-panel" aria-label="Preparação do ambiente">
      <div className="panel-title">
        <h2>Preparação do ambiente</h2>
        <ShieldCheck size={15} className="muted" />
      </div>
      {setup.error ? (
        <ErrorState error={setup.error} retry={() => void setup.refetch()} />
      ) : setup.isPending ? (
        <Skeleton count={2} />
      ) : (
        <>
          <p className="muted">
            Configuração e verificação são etapas diferentes. Os indicadores vêm dos diagnósticos do servidor.
          </p>
          <div className="row-list">
            {checks.map((check) => (
              <div className="row-item" key={check.id}>
                <div>
                  <strong>{check.label}</strong>
                  <p>{check.reason}</p>
                  {!compact && check.action && <p className="setup-action">{check.action}</p>}
                </div>
                <Status value={check.state} />
              </div>
            ))}
          </div>
          <div className={`notice ${setup.data?.spending?.enabled ? 'warning' : ''}`}>
            <ShieldCheck size={14} />
            <span>
              {setup.data?.spending?.enabled
                ? 'Processamento com gasto habilitado. Os limites locais são estimativas, não um teto garantido do provedor.'
                : 'GPU desativada. Serviços implantados podem gerar outros custos; configurar credenciais não inicia a biblioteca completa.'}
            </span>
          </div>
          {next && (
            <div className="setup-next">
              <CircleCheck size={16} />
              <div>
                <strong>Próxima ação: {next.label}</strong>
                {next.description && <p className="muted">{next.description}</p>}
              </div>
              {href && (
                <Button asChild variant="outline" size="sm">
                  <Link to={href}>
                    Continuar
                    <ArrowRight size={13} />
                  </Link>
                </Button>
              )}
            </div>
          )}
          <div className="inline between" style={{ marginTop: 16 }}>
            <small className="muted">Diagnóstico: {date(setup.data?.checked_at, true)}</small>
            {compact && (
              <Button asChild variant="ghost" size="sm">
                <Link to="/setup">
                  Ver diagnóstico e release
                  <ArrowRight size={13} />
                </Link>
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
