# Situação dos achados — v1.1

Atualizado em 19/10/2026. A inspeção confirmou os defeitos no código existente;
o arquivo `PHOTO_INTELLIGENCE_AUDITORIA_2026-10-17.md` não estava no checkout.
Compose/VPS e os contratos anteriores foram preservados. Não houve criação de
recursos Google, autenticação Apple, implantação Modal ou teste físico no iPhone.
“Corrigido localmente” não significa integração de produção validada.

Os testes abaixo identificam regressões executáveis e evidências localizadas.
O gate final exige repetir a suíte e registrar o mesmo SHA limpo no manifesto.
Resultados de v1.0, árvore suja ou outro SHA não aprovam esta release.

| Identificador | Severidade | Estado da correção | Validação externa pendente |
| --- | --- | --- | --- |
| P0-01 | P0 | Correção e regressões locais | Importação real 500/1.000 após gates |
| P0-02 | P0 | Pipeline isolado implementado | Falhas/retries no iCloud real |
| P0-03 | P0 | Corrigido com testes PostgreSQL locais | Interrupção e concorrência Cloud Run |
| P0-04 | P0 | Proteções implementadas; escrita indisponível | PhotoKit/Pyto e uma foto no aparelho |
| P0-05 | P0 | Gates persistentes implementados | Gates reais B–F não aprovados |
| P1-01 | P1 | Defaults/segredos corrigidos | Configuração e rotação nas contas |
| P1-02 | P1 | Backfill resumível implementado | Throughput/throttling reais |
| P1-03 | P1 | Integridade implementada | Representações iCloud reais |
| P1-04 | P1 | Destino Cloud Run/Neon implementado | Deploy, IAM, TLS/pooler e smoke reais |
| P1-05 | P1 | Perfis e capacidade parcial | 176k completo e quota vigente |
| P1-06 | P1 | Harness representativo; execução parcial | Rodada completa 100k/176k |
| P1-07 | P1 | Cache/fallback implementados | Modal real e checkpoint atualizado |
| P1-08 | P1 | Backup de conteúdo/restore local | Restore Neon/R2 e cópia independente |
| P1-09 | P1 | Protocolo físico disponível | Safari/PWA físicos e Access real |

## P0-01 — Expansão de importação

- **Causa raiz:** API aceitava confirmação, mas ingestão reaplicava `min` com o
  limite inicial, reduzindo silenciosamente o lote.
- **Componentes:** `services/import_policy.py`, `routers/operations.py`,
  `services/discovery.py`, `services/ingestion.py` e payload em `jobs`.
- **Correção:** limites inicial, máximo autorizado e hard separados; snapshot
  persistido contém `confirmed_expansion` e `requested_batch_limit`. Runner
  valida sem clamp; revogação posterior gera erro explícito. Retry consome apenas
  o restante da autorização original.
- **Regressão:** `tests/test_import_authorization_v11.py`,
  `tests/integration/test_import_api_v11.py` e
  `tests/integration/test_discovery_pipeline_v11.py`: 100 sem confirmação,
  500/1.000 confirmados, recusa sem confirmação/acima do hard e retry limitado.
- **Evidência:** HTTP verifica autorização persistida; pipeline controlado verifica
  contagem efetiva. Ver [manifesto de ingestão](../architecture/ingestion-manifest-v11.md).
- **Resultado:** corrigido localmente. Expansão real exige gates e capacidade;
  confirmar um lote de 100 não autoriza a biblioteca inteira.

## P0-02 — Uma foto bloqueia o lote

- **Causa raiz:** descoberta/download compartilhavam execução e transação;
  exceção de um asset revertia progresso independente.
- **Componentes:** `discovery.py`, `ingestion.py`, `jobs.py`, `worker.py`,
  `discovery_scans`, `discovery_manifests` e controles de falha na PWA.
- **Correção:** checkpoint/manifesto confirmados antes de jobs individuais
  `media_download`; estados, categorias, tentativas e erros por asset/revisão.
  Backoff com jitter limitado, quarentena e retry auditados sem apagar conteúdo.
- **Regressão:** `test_500_assets_one_failure_keeps_499_downloaded_and_checkpoint`
  em `tests/integration/test_discovery_pipeline_v11.py` exige 499 downloads,
  erro na foto 137, checkpoint e retomada idempotente. O mesmo arquivo cobre
  registro remoto inválido; `test_readiness_v11.py` cobre retry/quarentena/fencing.
- **Evidência:** PostgreSQL real e imagens procedurais com falhas controladas.
- **Resultado:** isolamento implementado. Falhas e throttling Apple reais ainda
  precisam ser exercitados no Gate B.

## P0-03 — Transações longas durante I/O

- **Causa raiz:** sessão e locks PostgreSQL abrangiam R2, decode e Modal.
- **Componentes:** `worker.py`, `jobs.py`, `leases.py`, `media.py`, `inference.py`,
  `outbox.py`, `task_runner.py` e migrations de expansão.
- **Correção:** preparar/confirmar descritores, executar I/O sem transação e
  confirmar resultado em transação curta. Owner/lease/fencing/revisão bloqueiam
  resultado antigo. Intents precedem uploads imutáveis; manutenção reconcilia
  somente chaves registradas sem referência ativa. Outbox dispara Jobs nomeados.
  Runner finito respeita deadline/SIGTERM e a fila permanece a autoridade.
- **Regressão:** `tests/integration/test_worker_transactions_v11.py`: crash após
  upload, roubo da posse, concorrência, SIGTERM, inferência sem conexão retida e
  retenção interrompida. `test_dispatch_outbox.py` unitário/integrado cobre dispatch.
- **Evidência:** [relatório P0-03](WORKER_TRANSACTION_REMEDIATION.md) registra
  comandos executados com PostgreSQL real; R2/GPU são adapters controlados.
- **Resultado:** corrigido localmente. Interromper Cloud Run real e observar
  recuperação continua obrigatório antes de produção.

## P0-04 — Keywords Apple

- **Causa raiz:** protocolo existia, mas writer Pyto não tinha suporte comprovado;
  símbolo no SDK não comprova disponibilidade no runtime.
- **Componentes:** `bridges/pyto/bridge.py`, `services/apple_sync.py`,
  `routers/bridge.py`, `PYTO_BRIDGE.md` e protocolo físico.
- **Correção:** executável permanece read-only para keywords. Probe observa APIs
  públicas sem escrever; `native_write_verified=false`. Switch do operador,
  mapping inequívoco, revisão, aprovação, delta aditivo e read-back obrigatórios.
  Recibo falso é recusado; operação pendente não vira sucesso por falta de API.
- **Regressão:** `tests/test_bridge.py`, `test_bridge_write_guard_v11.py`,
  `test_apple_sync.py`, `test_pyto_keychain.py` e
  `tests/integration/test_bridge_protocol.py`.
- **Evidência:** documentação Apple consultada indica iOS 27.0 nas APIs relevantes;
  não comprova acesso pelo Pyto. [Segurança](SECURITY_VERIFICATION.md) distingue
  inventário/recibos sintéticos de PhotoKit real.
- **Resultado:** segurança corrigida; escrita nativa **indisponível e não verificada**.
  Exige adaptador suportado e uma foto explicitamente selecionada, sem bloquear cloud.

## P0-05 — Validação real ponta a ponta

- **Causa raiz:** fixtures/CPU não comprovavam Apple→Modal→Safari.
- **Componentes:** `services/verification.py`, `routers/readiness.py`,
  `verification_gates`, `/setup` e manifesto de release.
- **Correção:** gates A–F persistidos com pré-requisitos e evidência vinculada ao SHA.
  UI distingue configuração, disponibilidade e verificação. Atestado explícito
  do operador não é apresentado como auditoria independente; fixture não prova Apple.
- **Regressão:** `tests/integration/test_readiness_v11.py` verifica evidência,
  pré-requisitos, SHA divergente e bloqueio de aprovação real por fixture;
  `tests/test_release_provenance.py` cobre manifesto seguro.
- **Evidência:** código/testes locais; instalação não preenche gates automaticamente.
- **Resultado:** framework implementado; gates reais B–F pendentes. Backfill completo
  não foi liberado nem executado.

## P1-01 — Configuração e segredos

- **Causa raiz:** defaults/material de configuração podiam aparentar integração
  configurada; histórico e dependências exigiam revisão.
- **Componentes:** `.env.example`, `config.py`, `setup-env.py`, CI, Gitleaks e API.
- **Correção:** iCloud/GPU/native write/auto delete desativados, conta/biblioteca
  vazias, inicial 100. Produção fail-closed; Cloud Run exige TLS/gates e sessão
  criptografada quando iCloud habilitado. Uvicorn não confia em forwarded headers.
- **Regressão:** `tests/test_settings_environment.py`, `test_foundation_security.py`,
  `test_cloud_run_security.py` e `test_infra_safety.py`.
- **Evidência:** [relatório de segurança](SECURITY_VERIFICATION.md) registra
  Gitleaks no histórico/snapshot e exceções exatas de constantes públicas/fixtures.
  Histórico não foi reescrito. Isso não audita secrets ignorados nem substitui rotação.
- **Resultado:** defaults/varredura locais corrigidos. Auditoria GPU encontrou
  advisories em Transformers 4.57.6; atualização para 5.10.2 e namespace de
  preprocessamento `0007` estão em validação separada. Não declarar imagem GPU
  limpa/validada antes de repetir auditoria e smoke compatível.

## P1-02 — Backfill de 176 mil fotos

- **Causa raiz:** revisita da cabeça e offset remoto tratado como cursor confiável.
- **Componentes:** `discovery.py`, `ingestion.py`, `task_runner.py`, manifesto,
  orçamento de bytes e admissão de catálogo.
- **Correção:** backfill/incremental/reconciliação com cursores separados.
  `startRank` é otimização validada por 32 anchors; deslocamento reinicia descoberta
  reutilizando manifests, sem refazer resultados. Incremental usa overlap;
  reconciliação profunda cobre adições retroativas. Continuação exige alvo,
  perfil full, capacidade e Gate F do release; cada Job é finito.
- **Regressão:** `tests/integration/test_discovery_pipeline_v11.py`: interrupção,
  anchors deslocados, overlap, retry limitado, continuação até alvo exato e
  admissões concorrentes sem exceder o teto.
- **Evidência:** [estratégia implementada](../architecture/ingestion-manifest-v11.md)
  documenta limitações reais do SDK; não inventa cursor CloudKit estável.
- **Resultado:** implementado; prazo de 176k reais, throttling e throughput não
  medidos. Não há promessa de conclusão em um prazo específico.

## P1-03 — Integridade do cache

- **Causa raiz:** tamanho idêntico era interpretado como conteúdo íntegro.
- **Componentes:** `download_cache.py`, adapter icloudpd, `media.py`, `source_download`.
- **Correção:** tamanho, revisão, versão do manifesto, completion marker e SHA-256
  verificados; `.partial`, digest, `Content-Range`, fsync e replace atômico.
  Checksum opaco Apple não é anunciado como SHA-256. Só o recurso afetado é
  invalidado; indisponibilidade temporária não é corrupção.
- **Regressão:** `tests/test_download_integrity_v11.py` cobre igual tamanho/conteúdo
  diferente, parciais e revisão; `test_discovery_pipeline_v11.py` cobre reparação
  e outage; `test_worker_transactions_v11.py` cobre reidratação no cold start.
- **Evidência:** arquivos/objetos privados locais reais, sem fotos pessoais.
- **Resultado:** corrigido localmente; formatos variados reais fazem parte do Gate B.

## P1-04 — Cloud Run, Neon e sessão serverless

- **Causa raiz:** destino anterior dependia de VPS e cookies em volume persistente.
- **Componentes:** `infra/gcp/`, dispatch/outbox/runner, `db_connection.py`,
  `session_store.py`, relay Cloudflare e workflows WIF.
- **Correção:** API stateless; cinco Jobs finitos; Scheduler OAuth `jobs:run`
  inicialmente pausado; ADC/IAM por função e secrets versionados. Neon com TLS
  verificado, NullPool transacional e migration direta. Sessão AES-GCM em objeto
  imutável, lease/fencing/CAS PostgreSQL e diretório efêmero protegido. JWT Access
  validado mesmo no `run.app` público, que não é descrito como rede privada.
- **Regressão:** `infra/gcp/tests/test_commands.py`, `tests/test_gcp_dispatch.py`,
  `test_database_profiles.py`, `test_cloud_run_security.py`, `test_session_store.py`,
  `tests/integration/test_session_persistence.py` e `test_dispatch_outbox.py`.
- **Evidência:** [migração](MIGRATION_REPORT.md),
  [planos GCP](../evidence/gcp-offline-plans-v11.json) e
  [arquitetura](../architecture/CLOUD_RUN_TARGET.md). Configuração pooled testada
  com PostgreSQL local não comprova o pooler hospedado do Neon.
- **Resultado:** implementação offline/local disponível. Deploy, IAM efetivo,
  Scheduler, Neon TLS/cold start, R2 e sessão Apple real pendentes.

## P1-05 — Capacidade Neon

- **Causa raiz:** vetores, HNSW, tags e probabilidades brutas sem dimensionamento;
  quota Free não podia ser presumida suficiente.
- **Componentes:** `capacity-benchmark.py`, perfis limited/full, contador de
  admissão, `NEON_SETUP.md` e `COST_MODEL.md`.
- **Correção:** limited inicialmente 1.000 assets; full exige capacidade escolhida.
  Harness mede tabelas/índices/TOAST, vetores 768 e 30 tags/foto. Retenção completa
  de probabilidades é projeção separada; `halfvec` experimental não muda produção.
- **Regressão:** `tests/test_capacity_safety.py`, `test_database_profiles.py` e
  testes de admissão concorrente em `test_discovery_pipeline_v11.py`.
- **Evidência:** `docs/evidence/capacity-v11-1000.json` e `capacity-v11-10000.json`
  completos; 100k parcial, detalhado abaixo. JSONs registram SHA base, hash do
  harness e árvore suja; não são benchmark do artefato final imutável.
- **Resultado:** capacidade parcial medida; nenhuma garantia de Free para 176k.
  Quota vigente, margem de reindexação e medição 176k completa ainda necessárias.

## P1-06 — Benchmark representativo

- **Causa raiz:** 176k anterior cobria principalmente metadados; vetores/tags
  tinham menor volume/densidade.
- **Componentes:** `infra/scripts/capacity-benchmark.py` e JSONs `capacity-v11-*`.
- **Correção:** banco descartável próprio com vetores 768, HNSW, 30 tags/asset,
  recursos, revisões, álbuns, duplicados, jobs e cache. SQL/API, EXPLAIN ANALYZE,
  percentis conforme amostra, concorrência 1/5/20, inserção e índices medidos.
  Primeira consulta observada não é chamada de cache frio garantido.
- **Regressão:** `tests/test_capacity_safety.py` protege o destino descartável;
  `tests/test_benchmark_options.py` cobre opções do benchmark legado.
- **Evidência:** 1k/10k completos. Em `capacity-v11-100000.json`, população/HNSW/SQL
  concluíram, banco de 2.695.887.895 bytes, mas status global failed. Logs/JSONs
  preservam falta de shared memory/disco e ajustes do executor. É medição parcial
  sintética, não capacidade de produção nem teste Neon.
- **Resultado:** execução completa 100k/176k e comparação final pendentes de
  executor suficiente; benchmark antigo 176k não substitui esta validação.

## P1-07 — Embeddings textuais caros

- **Causa raiz:** encoder remoto repetido sem cache durável/single-flight/fallback.
- **Componentes:** `query_cache.py`, `inference.py`, `search.py`, migration `0006` e UI.
- **Correção:** NFKC/casefold/espaços; chave por modelo/revisão/preprocessamento.
  TTL/teto/lease/fencing; I/O sem transação. Filtros exatos e texto continuam
  quando encoder falha, com aviso e sem similaridades inventadas.
- **Regressão:** `tests/integration/test_query_embedding_cache.py` cobre concorrência,
  hit sem inferência, expiração, limite, fencing, conexão liberada e fallback;
  `tests/test_database_profiles.py` cobre namespace e normalização.
- **Evidência:** PostgreSQL real com encoder controlado; não mede cold start Modal.
  A atualização de preprocessamento em `0007` impede reutilização entre convenções
  incompatíveis e exige validação própria do modelo.
- **Resultado:** cache/fallback implementados e exercitados localmente; checkpoint
  atualizado e ranking real ainda não declarados validados.

## P1-08 — Backup e restore completos

- **Causa raiz:** dump/listing não preservavam os bytes dos derivados fora do R2.
- **Componentes:** `services/backup.py`, `backup-restore-ci.py`, Makefile, guard de
  migration e `DISASTER_RECOVERY.md`.
- **Correção:** dump consistente/exportações e bytes privados em chunks AES-GCM.
  Restore em alvo vazio/compatível verifica fingerprints, head e read-back/hash;
  conteúdo divergente bloqueado. Recibo de integridade não substitui restore.
- **Regressão:** `tests/test_application_backup.py`: corrupção, chave errada,
  traversal, substituição entre backups e chunks; script de restore em bancos
  descartáveis e imagens procedurais.
- **Evidência:** [application-restore-v11.json](../evidence/application-restore-v11.json)
  passou com fingerprints iguais, três imagens decodificadas, embedding 768,
  tags/álbum/jobs, retry e preview reparado. Rodada documentada usou head `0006`;
  repetir no head final da release.
- **Resultado:** mecanismo local verificado; segunda cópia independente, retenção,
  custos e restore Neon/R2 reais dependem do operador. Não copia originais iCloud.

## P1-09 — Safari físico e autenticação

- **Causa raiz:** WebKit automatizado não reproduz hardware, Keychain, PWA,
  sessão Access e redes do iPhone.
- **Componentes:** PWA, Access, relay, proxy privado de mídia e Pyto.
- **Correção:** [protocolo físico](../operations/iphone-acceptance.md) inclui
  Safari/PWA, Wi-Fi/celular, expiração/reauth, safe areas, teclado, seleção/zoom,
  virtualização, origin direto, previews e Service Auth separado.
- **Regressão:** Playwright/frontend cobrem fluxos automatizáveis;
  `tests/test_cloud_run_security.py` e `test_private_media_streaming.py` cobrem
  JWT, origin e mídia/ranges, sem substituir hardware.
- **Evidência:** testes locais e [segurança](SECURITY_VERIFICATION.md); nenhum
  registro de aceite físico ou login real foi produzido nesta execução.
- **Resultado:** pendente de dispositivo/contas. Não classificar como produção
  integralmente validada antes desses passos e dos demais gates externos.
