# Operação e recuperação v1.1

> **Nota de revisão arquitetural (04/11/2026):** Para triagem atual, priorize os IDs de correlação entre edge/API/Jobs, a observabilidade do Manage e a fila no PostgreSQL. Cloud Run opera com **Jobs finitos**, não com worker permanente na instância da API. Veja [implementação e fluxogramas](docs/architecture/OBSERVABILITY_AND_OPERATIONS.md).

Comece com 100 mídias e GPU desativada. Aumente ingestão depois de observar bytes,
latência, erros, disco, fila e custo. Lote 8/concorrência 1 são limites prudentes;
não representam throughput medido para 176 mil mídias.

## Cloud Run: rotina principal pelo iPhone

Use Safari para dashboards e Codespaces/Cloud Shell para o terminal. Não é
necessário Mac/Xcode. A API pode escalar a zero; jobs finitos usam fila e checkpoints
PostgreSQL. Não execute um worker infinito dentro do Cloud Run Service.

```bash
make gcp-doctor             # plano offline
make gcp-smoke              # plano de health e segurança
make gcp-doctor GCP_ARGS='--apply'  # consultas autenticadas; sem criação
make gcp-smoke GCP_ARGS='--apply'
gcloud run jobs executions list --job photointel-worker --region REGION --project PROJECT
gcloud run jobs executions list --job photointel-discover --region REGION --project PROJECT
```

Configure `infra/gcp/config.local.json` antes desses comandos. Execução de Jobs,
deploy e retomada de Scheduler podem gerar cobrança: revise os planos e use
somente os parâmetros de autorização explícitos de
[CLOUD_RUN_SETUP.md](CLOUD_RUN_SETUP.md). `gcp-smoke` testa rejeição de acesso
anônimo ao origin além de saúde; não comprova login real no Safari.

Na PWA, acompanhe diagnósticos, autorização de escala, fila e último erro persistido.
Use pause antes de alterações de custos, modelos ou grandes lotes. Importações
de até 1.000 fotos não requerem gates: teste primeiro lotes pequenos.
Acima de 1.000 fotos, a autorização F exige evidências de capacidade/custos
além de limites de lote, perfil full para backfill contínuo e confirmação da meta.

O perfil Neon inicial limita o catálogo; não basta aumentar `INITIAL_IMPORT_LIMIT`
para autorizar expansão. API e execução validam os limites, o operador confirma
expansão e os limites de capacidade continuam aplicáveis. Configure conexões de runtime
pooled/TLS e migração direta conforme [NEON_SETUP.md](NEON_SETUP.md).
Sessões expiradas são recuperadas em terminal, com o fluxo criptografado de
[ICLOUD_SESSION_SETUP.md](ICLOUD_SESSION_SETUP.md), nunca digitando senha na PWA.

## Rotina Oracle/VPS e Compose (fallback)

Use SSH com chave e verificação de host. O aplicativo e credenciais rodam no
servidor; não é necessário compilar no iPhone nem abrir Mac/Xcode.

```bash
cd /opt/photointel
PHOTOINTEL_COMPOSE_MODE=prod bash infra/scripts/compose.sh ps
PHOTOINTEL_COMPOSE_MODE=prod bash infra/scripts/compose.sh logs --tail=100 api worker ingestion
PHOTOINTEL_COMPOSE_MODE=prod bash infra/scripts/compose.sh exec -T api python -m photointel.cli doctor --json
df -h
du -sh var/postgres var/processing var/icloud-downloads backups
```

Não cole logs sem revisar dados pessoais. Não execute `env`, `docker inspect`,
`cat .env`, `cat .env.runtime`, nem imprima cookies/chaves para coletar um diagnóstico. Identificadores
de mídias e metadados também são privados.

API tem healthcheck HTTP; worker/ingestion escrevem heartbeat do event loop em
`/tmp` e ficam unhealthy quando ausente ou com mais de 120 segundos. Isso mede
vida do processo. Readiness iCloud/GPU/Apple é distinta e exige diagnóstico e
exercício real. Docker `restart: unless-stopped` reinicia processos que encerram;
estado unhealthy sozinho não causa reinício automático.

## Backup e teste de recuperação

O mecanismo recomendado copia dump PostgreSQL e **conteúdo dos objetos privados**
para chunks AES-GCM independentes do bucket primário:

```bash
make backup-application BACKUP_DIRECTORY=backups/NOVA_RELEASE BACKUP_KEY_FILE=/caminho/privado/backup-key
make verify-backup BACKUP_DIRECTORY=backups/NOVA_RELEASE BACKUP_KEY_FILE=/caminho/privado/backup-key
# Somente contra PostgreSQL de teste, com APP_ENV=test:
make restore-application-test POSTGRES_CONTAINER=seu-container-postgres
```

Clientes `pg_dump`/`pg_restore` compatíveis com o servidor precisam estar no
terminal; o teste pode usar os clientes do container indicado. A cópia real deve
ter uma segunda localização durável privada e chave preservada separadamente.
A CLI `verify --verification-receipt` produz prova de integridade autenticada;
`restore --verification-receipt` também confirma banco e leitura dos objetos.
O recibo de integridade sozinho não comprova restauração. A implantação exige
backup verificado para migração de uma base existente.

[DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) contém criação da chave, TLS/conexão
direta Neon, comandos exatos, guard de banco vazio, retomada e política de custo.
O teste sintético usa bancos descartáveis, imagens procedurais e vetores
explicitamente sintéticos. Não acessa Apple nem Modal; restore real de Neon/R2
continua dependente das contas e do destino autorizado.

Os comandos legados `make backup` e `make restore-test` mantêm compatibilidade:
salvam/testam banco/exportações com Compose e **não incluem bytes R2**. Não os
interprete como backup completo dos derivados. Nenhuma dessas cópias substitui
backup dos originais que permanecem em iCloud.

## Atualização e rollback

Registre o manifesto de release, commit, imagens/digests, frontend release ID,
versão Alembic, revisões dos modelos e runs de CI implantados. Não misture evidência
de uma revisão anterior com validação da release atual. Em Cloud Run, publique a
imagem imutável ligada ao SHA, use migration Job separado e mantenha a revisão
anterior para `make gcp-rollback` (plano por padrão). Não faça downgrade destrutivo
para simplificar rollback. O procedimento abaixo é o fallback VPS.

Registre commit, imagens/digests e versão Alembic implantados. Construa imagens
ARM64 no CI ou host compatível, pause novos jobs, faça backup e aplique migração.
Inicie API e confirme readiness antes de retomar workers. Se a migração alterar
dados irreversivelmente, rollback exige restore testado; trocar somente o tag da
imagem pode não ser compatível com o schema novo.

```bash
PHOTOINTEL_COMPOSE_MODE=prod bash infra/scripts/compose.sh pull
PHOTOINTEL_COMPOSE_MODE=prod bash infra/scripts/compose.sh up -d
```

Esses comandos usam os tags configurados. Em produção substitua tags locais por
versões fixas/digests revisados. Não atualize banco e modelos sem verificar
compatibilidade/dimensão do embedding.

## Falhas e limites

| Sintoma | Verificação inicial |
|---|---|
| API não pronta | Migração, conexão PG, auth/armazenamento production |
| Jobs parados | Scheduler pausado/última execução finita, outbox, lease, attempts e erro persistido |
| iCloud requer autenticação | Snapshot ausente/expirado, lease de sessão e login/publicação interativos |
| Representação indisponível | Tamanho/formato permitido; não habilite original automaticamente |
| GPU desabilitada | Revisões/token/backend configurados e orçamento revisado |
| Apple `mapping_required` | Mapeamento verificado no dispositivo e revisão atual |
| Banco/storage crescendo | Perfil/cap Neon, HNSW/tags/raw predictions, retenção de jobs/backups e temporários |
| Access em loop | Hostnames/políticas, API session, CORS e cookies no Safari |

Os limites de GPU estimam trabalho e custo. Habilite alertas/limites do provedor
e monitore uso faturado; execução/cold start/preço real podem divergir das
estimativas. Pausar lote não necessariamente encerra uma chamada GPU já iniciada.

`python3 infra/scripts/cleanup-temp.py` faz dry-run; `--apply` remove arquivos
expirados apenas em `var/processing` deste repositório, recusando symlinks de diretório. Não use esse script sobre
downloads, sessão ou biblioteca. Derivados permanentes só podem ser regenerados
se a representação necessária continuar disponível.
