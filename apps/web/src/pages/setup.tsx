import { FileCheck, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useAction, useApi } from '../api/client';
import type { ReleaseInfo, VerificationGate, VerificationGates } from '../api/operations';
import { DetailList, ErrorState, PageHeader, Skeleton, Status } from '../components/common';
import { SetupStatusPanel } from '../components/setup-status';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { date } from '../lib/format';
import { FRONTEND_RELEASE_ID } from '../lib/release';
import { useUi } from '../lib/store';

export function SetupPage() {
  const gates = useApi<VerificationGates>('/v1/verification/gates', 30_000);
  const release = useApi<ReleaseInfo>('/v1/release');
  const update = useAction('/v1/verification/gates', 'PATCH');
  const [selected, setSelected] = useState<VerificationGate | null>(null);
  const [evidence, setEvidence] = useState('');
  const [notes, setNotes] = useState('');
  const [attested, setAttested] = useState(false);
  const [outcome, setOutcome] = useState('passed');
  const releaseMismatch =
    !!FRONTEND_RELEASE_ID && !!release.data?.git_sha && FRONTEND_RELEASE_ID !== release.data.git_sha;
  function close() {
    setSelected(null);
    setEvidence('');
    setNotes('');
    setAttested(false);
  }
  return (
    <>
      <PageHeader
        eyebrow="Implantação controlada"
        title="Preparação e validação"
        description="Diagnóstico operacional e uma autorização opcional para importações acima de 1.000 fotos. Lotes menores não exigem gates."
      />
      <SetupStatusPanel />
      {releaseMismatch && (
        <div className="notice">
          Frontend e API foram publicados de commits diferentes, o que é normal em deploys independentes. Isso
          não bloqueia o registro de verificações da API. Compatibilidade funcional continua dependendo dos
          testes e contratos.
        </div>
      )}
      <section className="panel" style={{ marginTop: 20 }} aria-label="Autorização para importações grandes">
        <div className="panel-title">
          <h2>Importações em larga escala</h2>
          <ShieldCheck size={16} className="muted" />
        </div>
        <div className="notice">
          <ShieldCheck size={15} />
          <span>
            {gates.data?.full_backfill_unlocked
              ? 'Autorização de escala registrada para esta API. Ainda são necessários confirmação explícita e limites de lote, armazenamento e custos.'
              : 'Importações de até 1.000 fotos não exigem gates. Para volumes maiores, registre uma única autorização de escala com evidência.'}
          </span>
        </div>
        {gates.error ? (
          <ErrorState error={gates.error} retry={() => void gates.refetch()} />
        ) : gates.isPending ? (
          <Skeleton />
        ) : (
          <div className="gate-list">
            {gates.data?.items.map((gate) => (
              <article className="gate-item" key={gate.id}>
                <div className="gate-title">
                  <div>
                    <span className="eyebrow">AUTORIZAÇÃO DE ESCALA</span>
                    <h3>{gate.name}</h3>
                  </div>
                  <Status value={gate.status} />
                </div>
                <p className="muted">{gate.reason}</p>
                {!!gate.requirements?.length && (
                  <ul className="gate-requirements">
                    {gate.requirements.map((requirement) => (
                      <li key={requirement}>{requirement}</li>
                    ))}
                  </ul>
                )}
                {!!gate.evidence?.length && (
                  <details>
                    <summary>Referências registradas</summary>
                    <ul className="gate-references">
                      {gate.evidence.map((reference) => (
                        <li key={reference}>
                          <code>{reference}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <div className="inline between">
                  <small className="muted">
                    {gate.verified_at ? date(gate.verified_at, true) : 'Sem verificação registrada'}
                  </small>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!release.data?.git_sha || gate.status === 'blocked'}
                    onClick={() => {
                      setSelected(gate);
                      setOutcome('passed');
                    }}
                  >
                    <FileCheck size={13} />
                    Registrar verificação
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="panel" style={{ marginTop: 20 }} aria-label="Release instalada">
        <div className="panel-title">
          <h2>Release instalada</h2>
          <FileCheck size={16} className="muted" />
        </div>
        {release.error ? (
          <ErrorState error={release.error} retry={() => void release.refetch()} />
        ) : release.isPending ? (
          <Skeleton />
        ) : (
          <>
            <div className="notice">
              <span>
                {release.data?.notice ??
                  'Proveniência identifica o build; não substitui testes de integrações reais.'}
              </span>
            </div>
            <DetailList
              data={{
                sha: release.data?.git_sha,
                branch: release.data?.branch,
                api: release.data?.api_version,
                build: date(release.data?.build_timestamp, true),
                image: release.data?.container_digest ?? 'Não informado',
                frontend: FRONTEND_RELEASE_ID ?? 'Build web sem identificação',
                frontend_expected: release.data?.frontend_release_id,
                migration: release.data?.database_migration_head,
                infra: release.data?.infrastructure_hash,
                modal: release.data?.modal_deployment_id ?? 'Não verificado',
              }}
              labels={{
                sha: 'Git SHA',
                branch: 'Branch',
                api: 'API',
                build: 'Build',
                image: 'Digest do container',
                frontend: 'Frontend instalado',
                frontend_expected: 'Frontend esperado pela API',
                migration: 'Migration head',
                infra: 'Hash de infraestrutura',
                modal: 'Modal deployment',
              }}
            />
            {Object.entries(release.data?.models ?? {}).map(([model, value]) => (
              <div className="row-item" key={model}>
                <strong>{model}</strong>
                <code className="release-revision">{value.revision ?? 'Revisão não informada'}</code>
              </div>
            ))}
            {release.data?.test_results.map((check) => (
              <div className="row-item" key={`${check.name}-${check.reference}`}>
                <div>
                  <strong>{check.name}</strong>
                  <p className="release-reference">{check.reference}</p>
                </div>
                <Status value={check.status} />
              </div>
            ))}
            {!release.data?.test_results.length && (
              <p className="muted" style={{ marginTop: 16 }}>
                Sem evidências de testes vinculadas a este SHA.
              </p>
            )}
          </>
        )}
      </section>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => !open && close()}
        title="Registrar verificação do gate"
        description="Para mais de 1.000 fotos, registre o teste e a referência que comprovem capacidade e custo. Não é necessário para lotes menores."
      >
        <div className="stack">
          <label className="field">
            Resultado
            <select value={outcome} onChange={(event) => setOutcome(event.target.value)}>
              <option value="passed">Teste passou</option>
              <option value="failed">Teste falhou</option>
              <option value="not_verified">Não verificado</option>
            </select>
          </label>
          <label className="field">
            Referências de evidência, uma por linha
            <textarea
              value={evidence}
              maxLength={4000}
              rows={4}
              placeholder="URL de execução ou referência de relatório privado"
              onChange={(event) => setEvidence(event.target.value)}
            />
          </label>
          <label className="field">
            Observações
            <textarea
              value={notes}
              maxLength={1000}
              rows={3}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
          <label className="checkbox-field">
            <span>
              Confirmo que executei esta verificação
              <small>
                Em hardware ou serviços reais quando o gate exige. Não inclua fotos, cookies ou segredos nas
                evidências.
              </small>
            </span>
            <input
              type="checkbox"
              checked={attested}
              onChange={(event) => setAttested(event.target.checked)}
            />
          </label>
          <p className="field-help">SHA: {release.data?.git_sha}</p>
        </div>
        <div className="form-actions">
          <Button variant="outline" onClick={close}>
            Cancelar
          </Button>
          <Button
            disabled={
              update.isPending ||
              !attested ||
              !release.data?.git_sha ||
              (outcome === 'passed' && !evidence.trim())
            }
            onClick={async () => {
              await update.mutateAsync({
                body: {
                  gate_id: selected?.id,
                  status: outcome,
                  evidence: evidence
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean),
                  notes,
                  release_sha: release.data?.git_sha,
                  operator_attestation: attested,
                },
              });
              close();
              useUi.getState().notify('Resultado de verificação registrado.');
            }}
          >
            Registrar resultado
          </Button>
        </div>
      </Dialog>
    </>
  );
}
