# Relatório de migração v1.1 — Cloud Run, Neon e recuperação

## Estado e alcance da evidência

A aplicação existente foi preservada. Compose e Oracle/VPS continuam disponíveis;
Cloud Run é um segundo destino de implantação. Nenhum recurso Google foi criado,
nenhuma identidade cloud está configurada neste executor e nenhum deploy real foi
executado. O trabalho permite revisar e testar localmente a integração, sem
declarar Cloud Run, Neon, R2 ou Modal operacionais.

Os testes desta revisão foram executados em 19/10/2026 sobre o checkout cujo
commit base é `73236e47012830533226c0c07f81a2712e1685d9`, com alterações locais
identificadas pelos commits incrementais posteriores. Esta referência identifica
o contexto da execução; não representa uma release imutável validada. O manifesto
final deve ser gerado após commit limpo e os testes devem apontar para seu SHA.

## Mudanças implementadas

| Componente | Implementação | Evidência e limite |
|---|---|---|
| API | Service stateless, min instances 0, cobrança por requisição, máximo e concorrência limitados, `$PORT`, probes | Definições renderizadas e testes locais; não publicado no Google |
| Trabalho assíncrono | Jobs finitos `discover`, `backfill`, `worker`, `maintenance` e `migrate` | Fila PostgreSQL, leases e fencing; execução Google pendente |
| Agendamento | Três chamadas OAuth para `jobs:run`, publicadas pausadas | Plano e assertions de IAM; nenhuma rotina foi ativada |
| Dispatch | Outbox transacional, nomes fixos, ADC com transporte limitado, HTTP fora da transação | Cinco testes com PostgreSQL real e chamadas Google simuladas |
| Migrações | Task separada, URL direta, serialização Alembic, somente credenciais de banco | Migração real até `0006_query_embedding_cache` em banco descartável |
| Neon | TLS verificado, perfil limitado/completo e adaptação ao endpoint transacional | Configuração e PostgreSQL local; TLS e cold start Neon aguardam conta |
| Sessão Apple | Snapshot autenticado AES-GCM, objeto imutável, ponteiro e lease em PostgreSQL | Implementação local; sessão Apple real ainda requer autenticação interativa |
| Autenticação | JWT Access validado na aplicação, inclusive acesso direto `run.app`; Bridge com identidade separada | Testes locais; smoke do origin real ainda não executado |
| Backup | Dump PostgreSQL e bytes de derivados privados em arquivo criptografado | Restore real local de banco e três imagens sintéticas, com read-back |
| Deploy | Scripts gcloud reproduzíveis, versões numéricas de secrets, imagem ligada ao commit e WIF manual | Planos offline; autorização de cobrança e contas ainda ausentes |

O origin `run.app` usa transporte público para o relay Cloudflare. Não é uma
rede privada: FastAPI deve rejeitar cada requisição privada sem JWT válido. A
permissão IAM `allUsers/run.invoker` não autoriza dados na aplicação. O container
não confia em forwarded headers arbitrários. O smoke real dessa fronteira continua
obrigatório antes de inserir fotos pessoais.

## Segurança de execução e migração

`infra/gcp/manage.py` não executa gcloud por padrão. Uma mutação exige os três
argumentos `--apply --authorize-charges --confirm-project PROJETO_EXATO`.
`doctor --apply` e `smoke --apply` fazem somente consultas/probes. Bootstrap
cria referências de secrets vazias; valores entram por prompt oculto e stdin,
sem argumentos de processo ou arquivos versionados.

API, Jobs, migrations, Scheduler, build e deploy usam seis service accounts.
Os runtimes podem invocar apenas Jobs nomeados e não podem executar migrations
ou alterar os argumentos via overrides. A identidade de migração não recebe
R2, Apple ou Modal. O teste de migração foi repetido com esses serviços sem
credenciais, confirmando a separação da inicialização completa da aplicação.

Para banco existente, o comando de migração agora exige recibo
`database-and-object-restore` correspondente ao ID e hash SHA-256 do manifesto
criptografado, com fingerprints do banco, head de migração e objetos lidos após
restore. Um recibo de `verify` comprova integridade e não libera migração.
O recibo é evidência controlada pelo operador, sem assinatura independente; não
transforma um arquivo arbitrário em prova confiável. A exceção
`--initial-empty-database` exige que o operador verifique um destino novo vazio.

## Verificações executadas

| Comando/escopo | Resultado observado |
|---|---|
| `python3 -m unittest discover -s infra/gcp/tests -q` | 18 testes passaram |
| `.venv/bin/pytest tests/test_gcp_dispatch.py tests/test_dispatch_outbox.py tests/test_task_runner_v11.py -q` | 12 testes passaram; credenciais e Google API simuladas |
| `.venv/bin/pytest tests/integration/test_dispatch_outbox.py -q` | 5 testes passaram em PostgreSQL/pgvector local, banco descartável próprio |
| Ruff dos arquivos GCP/dispatch/outbox/runner | Passou |
| Mypy de `cloud_dispatch.py`, `outbox.py`, `task_runner.py` | Passou nos três módulos |
| Todos os 11 alvos `make gcp-*` em modo plano | Passaram com gcloud sentinela; zero invocações do CLI |
| `python -m photointel.services.task_runner migrate --max-jobs 1 --deadline-seconds 1700` | Migrações aplicadas em banco local vazio sem credenciais de aplicação |
| `python infra/scripts/backup-restore-ci.py --postgres-container photointel-v11-postgres --report docs/evidence/application-restore-v11.json` | Backup/restore criptografado passou em bancos descartáveis e imagens sintéticas |

As URLs de conexão foram fornecidas por ambiente privado, nunca incluídas no
relatório ou nos comandos publicados. A restauração confirmou tags, álbuns,
revisões de modelo, embedding sintético de 768 dimensões e jobs. Três imagens
decodificaram após restore; um preview removido foi reparado no retry e conteúdo
corrompido do backup foi rejeitado. Isso valida o conteúdo do backup local, não
um serviço R2 real nem backup dos originais no iCloud.

Evidências estruturadas:

- [Planos GCP](../evidence/gcp-offline-plans-v11.json).
- [Restore de banco e conteúdo](../evidence/application-restore-v11.json).
- [Guia Cloud Run](../../CLOUD_RUN_SETUP.md).
- [Recuperação](../../DISASTER_RECOVERY.md).

## Sequência restante pelo iPhone

1. Revisar o commit limpo, os planos `make gcp-*` e o custo estimado.
2. Criar/selecionar contas e autorizar explicitamente o projeto e as cobranças.
3. Criar Neon e R2 privados; cadastrar credenciais no Secret Manager pelo prompt.
4. Configurar Access, Pages e relay Cloudflare; manter previews protegidos.
5. Executar bootstrap, build, implantação dos Jobs e migração com restore
   comprovado; depois publicar API e criar Scheduler pausado.
6. Executar smoke do `run.app` e autenticação Access real no Safari e na PWA.
7. Autenticar iCloud em terminal seguro, publicar snapshot e cumprir gates de
   10/100 imagens, Modal real e recuperação antes de expandir para 1.000.
8. Medir capacidade, throughput e custos; manter backfill completo bloqueado até
   autorização e gates correspondentes.

Os comandos exatos, rollback e isolamento dos secrets estão em
[CLOUD_RUN_SETUP.md](../../CLOUD_RUN_SETUP.md). Não houve migração de dados reais
Oracle → Neon, deploy Cloud Run, autenticação Apple, GPU Modal, propagação de
keywords nem validação em Safari físico nesta revisão.
