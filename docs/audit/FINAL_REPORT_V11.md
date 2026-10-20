# Entrega v1.1 — correções e prontidão verificável

Data: 20/10/2026. **Local development ready.** O catálogo funciona localmente com
API, PostgreSQL/pgvector, storage privado, workers e PWA. Cloud Run, Neon, R2 e
Modal de produção ainda dependem de contas, autorização e execução real. Nenhum
recurso Google ou GPU paga foi criado, nenhuma foto privada foi usada e nenhum
backfill de biblioteca completa foi iniciado.

## A. O que foi corrigido

Os detalhes de causa raiz, componentes, regressões e evidências estão em
[FINDINGS_STATUS.md](FINDINGS_STATUS.md). Cada resultado abaixo distingue código
corrigido de serviço externo validado.

| Achado | Resultado final desta execução | Pendência externa |
| --- | --- | --- |
| P0-01 — expansão ignorada | Limites autorizados persistidos; lotes controlados de 100/500/1.000 processados sem clamp silencioso | Lotes Apple reais após gates |
| P0-02 — uma foto bloqueava todas | Manifestos e jobs por asset; cenário 500 com falha na foto 137 processa as outras 499 e retenta somente a falha | Falhas/retries iCloud reais |
| P0-03 — transações longas | I/O fora de transações; leases, fencing, intents de objetos, outbox e recuperação testados em PostgreSQL | SIGTERM, concorrência e rede no Cloud Run |
| P0-04 — escrita Apple | Protocolo seguro, aprovação, mappings, revisão/read-back e recusa de sucesso falso; keywords Pyto permanecem read-only | Adaptador suportado e uma foto no aparelho |
| P0-05 — ausência de ponta a ponta real | Gates persistidos e vinculados à release; fixtures não liberam os gates reais | Gates B–F continuam pendentes |
| P1-01 — configuração | iCloud/GPU/native write/delete desligados; secrets fora do cliente; varreduras locais e dependências auditadas | Secrets/IAM/rotação nas contas |
| P1-02 — backfill lento | Backfill finito e retomável, separado de incremental, manifests e anchors; autorização explícita de alvo | Throughput/throttling Apple medidos |
| P1-03 — cache por tamanho | SHA-256, revisão, marker, `.partial` e conclusão atômica; corrupção de mesmo tamanho detectada | Representações reais heterogêneas |
| P1-04 — Cloud Run/Neon | Service stateless, Jobs finitos, Scheduler, Secret Manager, pooling/TLS, sessão cifrada e scripts preparados | Deploy e smoke reais |
| P1-05 — espaço Neon | Perfis limited/full e capacidade sintética medida; catálogo limitado a 1.000 por padrão | Medição completa 176k e plano contratado |
| P1-06 — benchmark | Vetores 768, 30 tags/foto, HNSW e concorrência; 1k/10k completos, 100k parcial | 176k não executado por limite de disco |
| P1-07 — consultas semânticas caras | Cache durável por modelo/revisão/preprocessing, single-flight, TTL, limites e fallback exato | Modal/cold starts e qualidade de ranking real |
| P1-08 — backup incompleto | Banco e bytes dos derivados cifrados; restore local com fingerprints, read-back e reparo idempotente | Segunda cópia independente e restore Neon/R2 |
| P1-09 — Safari físico | Checklist de aparelho e testes automatizados Chromium/WebKit Linux | Safari/PWA, Access e redes em iPhone físico |

Matriz de funcionalidades preservadas:

| Capacidade | Situação sustentada pela evidência |
| --- | --- |
| Galeria virtualizada, viewer, filtros, tags, álbuns, duplicados e Jobs | Implementados e testados localmente |
| API privada, validação JWT Access, Bridge Service Auth, mídia autenticada | Implementados e testados com chaves/transportes controlados; configuração externa pendente |
| Ingestão incremental/backfill e recuperação | Implementados e testados com fixtures; sessão iCloud real pendente |
| JoyTag e SigLIP 2 | Pesos reais executados em CPU, persistência confirmada; Modal/CUDA não executados |
| Busca semântica, similaridade e cache | Implementados; smoke CPU real limitado, regressões determinísticas e SQL local |
| Sessão Apple cifrada e Cloud Run Jobs | Implementados/testados localmente; Google/Apple reais pendentes |
| Pyto inventário/protocolo e Keychain | Implementados/testados no protocolo; validação PhotoKit/Keychain no aparelho pendente |
| Keywords nativas | Indisponíveis/não verificadas; nenhuma escrita falsa ou em massa |
| Backup/restore de metadados e derivados | Testado em banco descartável e três imagens procedurais |
| Reconhecimento facial, OCR, vídeo AI e compartilhamento público | Não implementados; permanecem fora do escopo v1.1 |

## B. O que foi migrado

O novo destino é **Pages/Access/Worker Cloudflare → Cloud Run Service → Neon**,
com derivados privados no R2 e inferência sob demanda no Modal. A fila PostgreSQL
continua sendo a fonte durável de trabalho. Não foram introduzidos brokers ou
Kubernetes.

`infra/gcp/` prepara `photointel-api` e os Jobs `discover`, `backfill`, `worker`,
`maintenance` e `migrate`. Scheduler usa OAuth para a API `jobs:run`, com três
agendamentos inicialmente pausados. A API não precisa de worker/cron em background;
tarefas finitas sobrevivem ao cold start por checkpoints, leases e idempotência.

Runtime usa pool pequeno/TLS; migração usa conexão direta e serialização separada.
Secret Manager fornece material estático; sessão Apple mutável é cifrada AES-GCM
em objeto privado com lease/fencing/CAS no PostgreSQL. O filesystem Run é efêmero.

O origin `run.app` é alcançável na Internet; cada endpoint privado valida JWT
Access na aplicação. Não é descrito como rede privada. O relay tem upstream fixo,
sem cache público de fotos. Compose e suporte VPS/Oracle foram preservados.
Não houve transferência de dados reais Oracle → Neon.

## C. O que depende de credenciais ou aparelho

- **Google:** projeto/billing autorizado, identidade gcloud ou WIF, IAM, Secret
  Manager e validação do Service/Jobs/Scheduler reais.
- **Neon:** branch/banco, pgvector, URLs pooled/direct, TLS, quota e plano com folga.
- **Cloudflare:** Pages/Access/Worker/domínio, preview protegido, bucket R2 privado
  e token restrito. Sucesso de `head_bucket` não comprova ausência de exposição pública.
- **Apple:** acesso web à biblioteca, login interativo/2FA no terminal, sessão
  verificada e publicação do snapshot cifrado; o comportamento de APIs não oficiais
  pode mudar. A senha não entra na interface web nem nos arquivos versionados.
- **Modal:** conta, aprovação de gastos, deploy, Proxy Auth Token e teste real.
- **iPhone:** Safari/PWA e Pyto/PhotoKit/Keychain físicos; keywords somente depois
  de suporte comprovado, aprovação, identidade inequívoca e teste de uma foto.

## D. Testes executados e proveniência

A rodada final de 20/10 usa o commit limpo
`2ce4015f5b5f89caa198bf5f186c23b5b6354806`. O label da imagem e `/v1/release`
correspondem a esse SHA; o diagnóstico dentro do container retorna v1.1.0.
As correções de Cloud Build, ZIP, TLS e CI estão incluídas. O commit posterior
destes documentos só publica evidências, sem reatribuir testes ao seu novo SHA.

[Resultados e hashes](../evidence/release-validation-v11.json) e
[manifesto](../evidence/release-manifest-v11.json) identificam a mesma origem.
O digest de registro e o ID efetivo do frontend local continuam `null`; o ID
local da imagem Docker é registrado separadamente. Não houve publicação cloud.
Os comandos e escopos estão em [VALIDATION.md](../../VALIDATION.md).

| Comando | Resultado |
| --- | --- |
| `APP_ENV=test .venv/bin/pytest -m 'not integration and not gpu and not e2e' -q --tb=short --junitxml=reports/release-unit.xml` | 319 passaram + 24 subtestes |
| `APP_ENV=test .venv/bin/pytest -m integration -q --tb=short --junitxml=reports/release-integration.xml` | 94 passaram, 235,68 s |
| `.venv/bin/ruff check .` | Passou |
| `.venv/bin/mypy apps/api/src gpu bridges` | Passou, 60 arquivos |
| `npm --prefix apps/web run typecheck` | Passou |
| `npm --prefix apps/web run lint` | 0 erros, 3 avisos Fast Refresh |
| `npm --prefix apps/web test -- --maxWorkers=2` | 37 passaram |
| `python3 -m unittest discover -s infra/gcp/tests -q` | 22 passaram sem Google |
| `node --test infra/scripts/zip-patch-policy.test.cjs infra/cloudflare/cloud-run-proxy/worker.test.mjs` | 7 passaram |

A rodada final E2E passou **58 cenários**, com duas capturas opcionais puladas,
em Chromium e WebKit Linux. O JSON registra a recuperação de falta de disco e
de biblioteca gráfica após o reinício do ambiente. O WebKit real foi executado
com a biblioteca Debian extraída, sem simular o navegador. Gitleaks 8.30.1 não
encontrou segredos nos **67 commits e 374 arquivos** examinados.

Integração recebeu URL de banco descartável por ambiente privado, sem credenciais
publicadas. Os testes cobrem os lotes 500/1.000, foto 137, retomada, posse concorrente,
crash após upload, I/O sem conexão retida, cache corrompido e fallback semântico.

As execuções anteriores abaixo conservam hashes/horários dos artefatos. Seus
runners não gravaram SHA Git, portanto elas **não são atribuídas ao commit final**:

- [CPU real Transformers 5.10.2](../evidence/real-cpu-v11.json): JoyTag 5.813
  probabilidades, SigLIP 2 768 dimensões, vetores finitos/normalizados, consultas
  portuguesas e persistência verificada em nova sessão. Uma imagem procedural,
  584,48 s, sem GPU alocada. Não mede qualidade de uma biblioteca real.
- [E2E](../evidence/e2e-v11.json): 58 passaram, duas capturas opcionais puladas,
  Chromium/WebKit Linux, PostgreSQL/MinIO descartáveis e fake de inferência restrito
  a teste. Não é prova de inferência real nem Safari físico.
- [Restore](../evidence/application-restore-v11.json): head `0007_model_preprocessing`,
  fingerprints iguais, três imagens decodificadas, tags/álbum/modelo/vetor/jobs,
  retry idempotente, preview faltante reparado e corrupção recusada.
- Compose: seis serviços saudáveis, 12 imagens sintéticas concluídas e 36 derivados
  privados HTTP 200; os dados permaneceram após reinício do executor.

O [manifesto de release](../operations/RELEASE_PROVENANCE.md) deve ser gerado da
árvore limpa da imagem publicada. IDs/digests desconhecidos permanecem `null`;
relatórios antigos não aprovam automaticamente os gates do novo SHA.

## E. Comandos para implantar, na ordem

O caminho local é funcional sem contas cloud:

```bash
make setup
make dev
make seed ASSETS=12
make test
make test-e2e
```

Abra a porta **5173** no Codespaces pelo Safari. O modo local mantém iCloud/GPU
reais desligados. Para preparar o destino cloud, sem criar recursos:

```bash
cp infra/gcp/config.example.json infra/gcp/config.local.json
chmod 600 infra/gcp/config.local.json
# Edite projeto/região/origins/referências de secrets, nunca valores secretos.
make gcp-doctor
make gcp-bootstrap
make gcp-build
make gcp-jobs-deploy
make gcp-deploy
make gcp-scheduler
```

Depois de autorização explícita de projeto/cobrança e configuração das contas,
siga [CLOUD_RUN_SETUP.md](../../CLOUD_RUN_SETUP.md). Os exemplos abaixo somente
passam à execução real com as três flags; não foram executados nesta entrega:

```bash
gcloud auth login --no-launch-browser
gcloud auth application-default login --no-launch-browser
make gcp-bootstrap GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID'
# Cadastre os secrets por prompt oculto conforme o guia antes de prosseguir.
make gcp-build GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID'
make gcp-jobs-deploy GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID'
# Primeira instalação: apenas em banco explicitamente confirmado vazio.
make gcp-migrate GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID --initial-empty-database'
make gcp-deploy GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID'
make gcp-scheduler GCP_ARGS='--apply --authorize-charges --confirm-project SEU_PROJECT_ID'
make gcp-smoke GCP_ARGS='--apply --origin https://ORIGIN_REAL.run.app'
```

Para banco existente, substitua a migration de instalação nova pela variante
com backup **restaurado** e recibo do guia. Não rode ambas. Configure Pages,
Access, previews e relay conforme [CLOUDFLARE_SETUP.md](../../CLOUDFLARE_SETUP.md).
Publique a sessão Apple pelo terminal conforme
[ICLOUD_SESSION_SETUP.md](../../ICLOUD_SESSION_SETUP.md); faça primeiro 10 imagens.
Modal exige ação separada, que pode consumir créditos:

```bash
uv sync --group gpu
uv run --group gpu modal token new
uv run --group gpu modal deploy gpu/modal_app.py
# Após secrets/checkpoints/limites e uma imagem sintética selecionada:
uv run --group gpu python -m gpu.smoke --asset-id UUID_DA_IMAGEM
```

Os procedimentos de importação de 10/100/1.000, backup, rollback e validação pelo
iPhone estão em [MIGRATION_CHECKLIST.md](../operations/MIGRATION_CHECKLIST.md).
Não habilite a biblioteca completa antes dos gates e autorização de capacidade.

## F. Custos e capacidade

Não foi medida fatura cloud. Os testes locais e o smoke CPU não alocaram GPU
Modal. Cloud Build, Registry, Scheduler, Secrets, logs, CPU/RAM/egress Run, Neon,
R2/operações/backups e Modal podem gerar cobrança. Free tiers e créditos não são
garantidos. Alertas e orçamentos da aplicação não são hard caps dos provedores.

O [relatório de capacidade](../../CAPACITY_REPORT.md) mediu dados sintéticos:
1.000 ativos ≈ 43,84 MB; 10.000 ≈ 287,21 MB; 100.000 ≈ 2,696 GB com vetores/HNSW,
30 tags/foto e resultados brutos completos em somente 1% da amostra. A execução
100k é parcial: as fases SQL/população concluíram, mas o ciclo API não concluiu.
A preflight recusou 176k por falta de disco; **não existe medição completa 176k**.

Não há comparação quantitativa equivalente entre o benchmark antigo e este
dataset: dimensões, densidade de tags e condições diferem. Não foi atribuída uma
melhoria percentual ao backfill sem iCloud real. O comparativo reproduzível de
mídia mede alocação local, não latência R2/Cloud Run: veja
[segurança e streaming](SECURITY_VERIFICATION.md).

A projeção de retenção bruta completa para 176k é 21,429 GB, extrapolada de 100k;
não é tamanho medido nem cotação Neon. Derivados R2 também são projeções, não
bytes pessoais observados. Um plano com capacidade suficiente e margem para
reindexação/histórico/backup será necessário; não prometa Neon Free para 176k.
Veja [COST_MODEL.md](../../COST_MODEL.md) e [NEON_SETUP.md](../../NEON_SETUP.md).

## G. Limitações

- Gates reais Apple → Modal → busca → Safari não passaram nesta execução.
- Pooler/cold start Neon, IAM/Scheduler Run, Access real e privacidade R2 precisam
  ser conferidos nas contas; testes locais não substituem essas verificações.
- WebKit Linux não cobre autenticação e execução de background no iPhone.
- Keywords nativas Pyto permanecem indisponíveis; pending não significa aplicado.
- Smoke CPU de uma imagem não comprova precisão, escala, latência ou custo GPU.
- Benchmark 176k e teste de capacidade cloud continuam pendentes.
- Backup dos metadados/derivados não é backup dos originais mantidos no iCloud.

As demais restrições estão em [LIMITATIONS.md](../../LIMITATIONS.md).

## H. Estado de release

**Local development ready.** Não foi selecionado “Cloud deployment ready”,
“Controlled production testing ready” ou “Full production validated”, pois não
há evidência de implantação externa e dos gates correspondentes.

## I. Próximas ações mínimas no iPhone

1. Abra o repositório no Codespaces, atualize o commit e execute `make dev`;
   abra a porta 5173 para testar o catálogo sintético funcional.
2. Escolha projeto/região/billing Google e plano Neon; revise custos e autorize
   explicitamente os recursos antes de aplicar os planos.
3. Configure Neon/R2/Access e secrets por terminal privado; siga a sequência E,
   com migração e Scheduler pausado. Verifique o origin direto e mídia privada.
4. Autentique Apple no terminal com 2FA, publique a sessão cifrada e valide 10
   imagens. Implante Modal com autorização, smoke real e custo medido.
5. Execute os gates 100/1.000 e o checklist físico Safari/PWA. Preserve os limites
   até comprovar recuperação, backup e capacidade. Keywords são uma etapa separada.
