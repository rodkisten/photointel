# Checklist de migração pelo iPhone — v1.1

Use Safari, GitHub Codespaces/Cloud Shell e dashboards oficiais. Não exige Mac,
Windows ou Xcode. Nenhum comando desta lista foi executado contra conta cloud
nesta implementação. Criação/publicação depende de autorização explícita do
projeto, região e possíveis cobranças. Preserve Compose/VPS e banco anterior.

Não copie credenciais para código, issue, chat, screenshot ou argumentos CLI.
Use ambiente privado do terminal e Secret Manager. Não execute benchmarks ou
fixtures contra Neon/R2 de produção.

## 1. Fixar release e validar localmente

- [ ] Abra o repositório no Codespaces pelo Safari e selecione o commit revisado.
- [ ] Configure PostgreSQL/S3 de desenvolvimento conforme README e execute:

```bash
git status --short
git rev-parse HEAD
make setup
make dev
make migrate
make seed ASSETS=100
make lint
make typecheck
make test
make test-integration
make test-e2e
make doctor
```

- [ ] Registre falhas/skips: skip não é aprovação. Confirme defaults iCloud/GPU/
  native write/auto delete desativados e limite inicial 100.
- [ ] Após commit limpo, gere manifesto e repita testes para o mesmo SHA:

```bash
make release-manifest
```

- [ ] Associe referências conforme [RELEASE_PROVENANCE.md](RELEASE_PROVENANCE.md).
  Evidência de árvore suja, outro SHA ou versão anterior não aprova esta release.

## 2. Preparar contas e dimensionar

- [ ] No Neon, escolha região/plano e branch de teste; siga
  [NEON_SETUP.md](../../NEON_SETUP.md). Verifique quota vigente e capacidade medida.
  Free não é presumido suficiente para 176k.
- [ ] Separe URL pooled runtime e direct migrations, com TLS verificado; mantenha
  ambas fora do JSON público. Inicialmente perfil limited e teto 1.000 assets.
- [ ] No Cloudflare, prepare R2 privado com credenciais mínimas. Confira domínio
  público/política; sucesso em `head_bucket` não prova privacidade.
- [ ] No Google Cloud Console, escolha projeto/billing/região e revise
  [COST_MODEL.md](../../COST_MODEL.md). Autorize criação/custos antes da etapa 4.
- [ ] Configure alertas e limites conservadores. Alertas/budgets da aplicação não
  são hard caps de cobrança garantidos pelos provedores.

## 3. Revisar planos offline

```bash
cp infra/gcp/config.example.json infra/gcp/config.local.json
```

- [ ] Edite o JSON no Codespaces: projeto, região, origins, equipe/audience/
  allowlist Access, bucket e referências numéricas de secrets. Não inclua valores
  secretos. Preserve `enable_icloud=false` e `enable_gpu=false`.
- [ ] Use SHA real na referência de imagem, não somente `latest`.
- [ ] Revise os comandos abaixo; sem `--apply` eles não chamam gcloud:

```bash
make gcp-doctor
make gcp-render
make gcp-bootstrap
make gcp-build
make gcp-jobs-deploy
make gcp-migrate
make gcp-deploy
make gcp-scheduler
```

- [ ] Confira API mínimo zero, cinco Jobs, IAM por função, Secret Manager e três
  agendamentos pausados. Resolva diagnósticos do `doctor`.
- [ ] Instalação do gcloud, prompts seguros e WIF estão em
  [CLOUD_RUN_SETUP.md](../../CLOUD_RUN_SETUP.md).

## 4. Implantação autorizada e secrets

**Esta etapa cria recursos e pode gerar cobrança.** Substitua `SEU_PROJECT_ID`
pelo projeto explicitamente autorizado; não execute para apenas testar o CLI.

```bash
gcloud auth login
make gcp-bootstrap GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID'
```

- [ ] Cadastre secrets por prompt oculto/stdin conforme o guia Cloud Run. Não use
  chave JSON persistente de service account. Senha Apple não é secret da aplicação.
- [ ] Fixe versões numéricas de secrets e conceda somente acessos necessários.
  Migrador recebe banco; não precisa Apple/R2/Modal para iniciar.
- [ ] Para Actions, configure WIF restrito ao repositório/branch/ambiente
  `production`, aprovadores e operação manual. Não publique a partir de PR.

## 5. Backup restaurado antes de migrar dados existentes

- [ ] Pause escritores/limpeza na janela necessária e preserve origem.
- [ ] Gere chave de backup privada separada conforme
  [DISASTER_RECOVERY.md](../../DISASTER_RECOVERY.md). `make backup` legado salva
  apenas PostgreSQL. Com ambiente apontando à origem correta:

```bash
make backup-application BACKUP_DIRECTORY=backups/RELEASE BACKUP_KEY_FILE="$HOME/.config/photointel/backup-key"
make verify-backup BACKUP_DIRECTORY=backups/RELEASE BACKUP_KEY_FILE="$HOME/.config/photointel/backup-key"
```

- [ ] Copie o diretório criptografado completo para destino privado independente.
  Listing/manifesto sem bytes não é backup de objetos. Preserve chave separadamente.
- [ ] Crie banco vazio `pi_restore_VALIDACAO` e storage privados isolados. Aponte
  o ambiente **ao destino isolado** antes de executar:

```bash
uv run python -m photointel.services.backup restore \
  --directory backups/RELEASE \
  --key-file "$HOME/.config/photointel/backup-key" \
  --confirm-database pi_restore_VALIDACAO \
  --verification-receipt backups/RELEASE/restore-verification.json
```

- [ ] Confirme fingerprints, migration head, read-back, tags, revisões de modelo,
  álbuns e jobs. Recibo de integridade isolado não libera migration.
- [ ] Se falhar, corrija/repita em destino isolado; não esvazie produção.

## 6. Publicar imagem, Jobs, migration e API

```bash
make gcp-build GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID'
make gcp-jobs-deploy GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID'
```

- [ ] Escolha **uma** alternativa de migration:

```bash
# Instalação nova, apenas se o destino foi confirmado vazio:
make gcp-migrate GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID --initial-empty-database'
# Banco existente, apenas após restore isolado recente:
make gcp-migrate GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID --backup-directory backups/RELEASE --backup-receipt backups/RELEASE/restore-verification.json'
```

```bash
make gcp-deploy GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID'
make gcp-scheduler GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID'
```

- [ ] Confira head final, digest, `/v1/release` e SHA web/API. API não aplica DDL
  em startup. Scheduler deve permanecer pausado. Não desligue origem anterior.

## 7. Proteger frontend, origin e mídia

- [ ] Siga [CLOUDFLARE_SETUP.md](../../CLOUDFLARE_SETUP.md): Pages/Access/Worker
  upstream fixo, incluindo proteção de previews e `pages.dev`.
- [ ] Access humano protege catálogo; Access Service Auth separado protege
  `/v1/bridge/*`. Backend valida JWT também no origin Run público.
- [ ] Faça probe anônimo do origin real:

```bash
make gcp-smoke GCP_ARGS='--apply --origin https://ORIGIN_REAL.run.app'
```

- [ ] Origin direto/mídia sem JWT e header de email forjado devem retornar 401/403.
  Repita audience/expiração erradas e cross-origin no ambiente real.
- [ ] No Safari, valide Access, galeria/mídia e reautenticação. A topologia não
  descreve `run.app` como rede privada.

## 8. Apple e gates controlados

- [ ] Registre Gate A da release limpa em `/setup`, com evidência de fixtures.
  Atestado manual não equivale a auditoria automática independente.
- [ ] Siga [ICLOUD_SESSION_SETUP.md](../../ICLOUD_SESSION_SETUP.md) no terminal
  seguro: chave AEAD, conta/biblioteca, autenticação interativa/2FA, verificação
  real e publicação do snapshot criptografado. Não use endpoint web para senha.
- [ ] `available_unverified` só indica snapshot presente; não comprova login Apple.
- [ ] Habilite iCloud após configuração/aprovação e publique nova revisão.
  Solicite **10 fotos** pelo painel; teste repetição, falha isolada e retomada.
  Registre evidência real do Gate B, sem cookies/fotos/tokens no relatório.
- [ ] Cumpra [MODAL_SETUP.md](../../MODAL_SETUP.md): implantação autorizada,
  checkpoints reais, tags, embedding 768, persistência, busca em português e
  custo medido. Registre Gate C; teste fake não o aprova.
- [ ] Só depois solicite **100 fotos** para Gate D e **1.000** para Gate E,
  respeitando confirmação de expansão, teto de catálogo e orçamento.
- [ ] Complete [aceitação física](iphone-acceptance.md): Safari/PWA, Wi-Fi/celular,
  Access expirado, teclado, safe areas, virtualização e mídia privada.
- [ ] Bridge read-only é validado separadamente; keywords continuam indisponíveis
  até adaptador suportado e prova de uma foto. Isso não bloqueia cloud.

## 9. Retomar operação e decidir expansão

- [ ] Revise storage/indexes, raw predictions, custos reais, throughput e backup.
  Benchmark sintético só em banco descartável, nunca Neon Free de produção.
- [ ] Após os gates necessários, retome apenas os agendamentos autorizados:

```bash
gcloud scheduler jobs resume photointel-worker --location REGION --project PROJECT
gcloud scheduler jobs resume photointel-maintenance --location REGION --project PROJECT
gcloud scheduler jobs resume photointel-discover --location REGION --project PROJECT
```

- [ ] Para biblioteca completa: perfil full dimensionado, capacidade e restore
  comprovados, orçamento e Gate F do SHA instalado. Alvo e autorização específicos;
  implantação não inicia 176.000 fotos automaticamente.
- [ ] Monitore jobs/falhas persistidos. Indisponibilidade Apple não significa
  exclusão; originais e mappings ambíguos permanecem sem escrita.

## 10. Interromper ou reverter

```bash
# Pausa Scheduler; não apaga banco, bucket ou fotos:
make gcp-cleanup GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID'
# Volta tráfego API; não reverte schema nem dados:
make gcp-rollback GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID --revision photointel-api-REVISAO_VERIFICADA'
```

- [ ] Para Jobs, restaure digest compatível e publique `gcp-jobs-deploy`.
- [ ] Não use downgrade destrutivo para simplificar rollback. Restauração exige
  destino isolado e preservação da origem/incidente.
- [ ] Só desative o destino anterior após gates, monitoramento e recuperação
  comprovados. Contas, credenciais, cobrança e testes físicos continuam externos.
