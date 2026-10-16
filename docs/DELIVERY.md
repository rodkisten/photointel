# Entrega técnica — Photo Intelligence Cloud v1.0

## A. Implementação

Monorepo com API FastAPI, PWA React/Vite, PostgreSQL/pgvector, storage privado,
ingestão iCloud/fixtures, processamento de imagens, jobs duráveis, JoyTag/SigLIP 2,
busca híbrida e Bridge Pyto. O catálogo não modifica nem exclui originais Apple.
O servidor continua trabalhando sem iPhone conectado. Produção exige configuração
e validação das contas reais; nenhum deploy foi executado automaticamente.

## B. Mapa do repositório

| Caminho | Responsabilidade |
| --- | --- |
| `apps/web` | PWA, galeria virtual, viewer, filtros, tags, álbuns e administração |
| `apps/api/src/photointel/routers` | Contratos HTTP `/v1`, autorização e operações |
| `apps/api/src/photointel/services` | Ingestão, mídia, jobs, busca, inferência e sync |
| `services` | Fronteiras e runbooks dos processos independentes |
| `gpu` | Modelos reais, protocolo validado, serviço Modal e smoke explícito |
| `bridges/pyto` | Script executável/importável, PhotoKit read e Keychain |
| `packages/contracts` | OpenAPI gerado; tipos web em `apps/web/src/api/schema.d.ts` |
| `packages/configuration` | Pins dos checkpoints e metadados públicos verificados |
| `packages/taxonomy` | Taxonomia versionada e categorias/aliases |
| `infra/migrations` | Alembic, constraints, índices, FTS e evolução do schema |
| `infra/docker`, `infra/oracle`, `infra/cloudflare` | Desenvolvimento e implantação |
| `tests`, `apps/web/src/test`, `apps/web/tests/e2e` | Testes Python, integração e navegador |
| `docs/evidence` | Relatórios reais com dados sintéticos, sem biblioteca pessoal |

## C. Matriz de capacidades

"Testado" identifica o escopo observado, não a operação de uma conta externa.
O estado mais recente de cada suíte está em [VALIDATION.md](VALIDATION.md).

| Capacidade | Estado |
| --- | --- |
| API, persistência, migrations, constraints e índices | Implementado e testado com PostgreSQL real |
| Auth JWT Access, allowlist e rejeição de cabeçalhos forjados | Implementado e testado; borda real exige configuração |
| Storage privado, thumbnails, EXIF, SHA/pHash e qualidade | Implementado e testado com MinIO/fixtures |
| Jobs, leases, retries, heartbeat e persistência de progresso | Implementado e testado com PostgreSQL/worker |
| Galeria, viewer, tags, filtros, álbuns e duplicatas | Implementado e testado; ver resultado E2E atual |
| Busca AST, FTS e similaridade SQL/pgvector | Implementado e testado; sem loop integral Python |
| JoyTag e SigLIP 2 com pesos reais | Implementado e testado em CPU, uma imagem sintética |
| Semântica em português | Embeddings reais testados; qualidade em biblioteca real ainda exige avaliação |
| Modal/T4, orçamento e autenticação do serviço | Implementado; requer configuração e smoke CUDA/Modal |
| iCloud incremental, sessão, limites e reconciliação | Implementado; requer login/2FA e importação real controlada |
| R2, Access, Tunnel, Pages e Oracle | Implementado; requer provisionamento e teste das contas |
| Bridge enrollment/inventory/mapping/diffs/approval | Implementado e testado no protocolo API |
| Pyto PhotoKit read, Keychain e Service Auth | Implementado; requer validação no iPhone/Access reais |
| Escrita nativa de keywords em Pyto | Não implementada como operacional; adapter bloqueia até API/capability verificada |
| WebKit Linux em perfil iPhone | Implementado e testado; 15 fluxos passaram, sem validar hardware Apple |
| Containers ARM64 | Workflows explícitos implementados; consultar evidência da execução |
| Reconhecimento facial, OCR, vídeo AI e compartilhamento público | Não implementado; fora do escopo v1 |

## D. Comandos

No Codespaces ou host Linux, depois de clonar o repositório:

```bash
make setup
make dev
make migrate
make seed ASSETS=100
make doctor
make lint
make typecheck
make test
make test-integration
npm --prefix apps/web run build
```

Integração exige banco migrado e storage disponíveis. Use um banco de testes
descartável. A suíte E2E precisa de `APP_ENV=test`, backend de inferência `test`,
revisões fictícias explícitas e navegador instalado; o procedimento executável
está em `infra/scripts/run-e2e.sh` e no workflow bootstrap. Não execute fixtures
ou benchmarks sobre uma biblioteca pessoal.

Autenticar e verificar iCloud no mesmo volume usado pelos serviços:

```bash
make icloud-auth
make icloud-verify
make icloud-libraries
make icloud-test
```

Em produção use o mesmo ambiente/volume da implantação:
`PHOTOINTEL_COMPOSE_MODE=prod make icloud-auth` e o mesmo prefixo para
`icloud-verify`, `icloud-libraries` e `icloud-test`.

Digite senha/2FA apenas no terminal interativo. Configure `ICLOUD_ACCOUNT` e
`ICLOUD_ENABLED` no host. Na PWA inicie a importação limitada a 100. Em ambiente
local autenticado, o equivalente é:

```bash
curl --fail --request POST http://localhost:8000/v1/ingestion/start \
  --header 'Content-Type: application/json' --data '{"limit":100}'
```

Para ampliar, ajuste `ingestion_import_limit` nas configurações e confirme a
expansão na interface. Runs finitos sucessivos continuam pelo cursor persistido.
Não existe importação automática de 176 mil imagens durante instalação.

Inferência real, somente depois de configurar o adapter e seus limites:

```bash
uv sync --group gpu
uv run --group gpu modal token new
uv run --group gpu modal deploy gpu/modal_app.py
uv run --group gpu python -m gpu.smoke --asset-id UUID_SELECIONADO
```

O último comando pode consumir créditos quando `INFERENCE_BACKEND=modal`.
Depois do smoke numa imagem, use Jobs → Processar lote com limite 100 para fotos
importadas enquanto GPU estava desabilitada; habilitar GPU não cria esses jobs
retroativamente. Confira resultados e custos antes de ampliar o lote.
O workflow CPU explícito não chama Modal. Instalação e testes comuns não iniciam
inferência real automaticamente. Consulte [MODAL_SETUP.md](../MODAL_SETUP.md).

Implantar API/worker no host preparado, com `.env` e `.env.runtime` revisados:

```bash
docker buildx build --platform linux/arm64 -f infra/docker/api.Dockerfile -t photointel-api:v1 --load .
docker buildx build --platform linux/arm64 -f infra/docker/web.Dockerfile -t photointel-web:v1 --load .
PHOTOINTEL_COMPOSE_MODE=prod bash infra/scripts/compose.sh up -d postgres
PHOTOINTEL_COMPOSE_MODE=prod bash infra/scripts/compose.sh run --rm migrate
bash infra/oracle/provision-app-role.sh
PHOTOINTEL_COMPOSE_MODE=prod bash infra/scripts/compose.sh up -d
```

Defina `PHOTOINTEL_IMAGE=photointel-api:v1` e
`PHOTOINTEL_WEB_IMAGE=photointel-web:v1` no controle Compose. Para AMD64 troque
a plataforma. Os pré-requisitos estão no [runbook Oracle](deployment/oracle-arm.md).

Publicar PWA, após configurar Access e o projeto Pages:

```bash
VITE_API_BASE_URL=https://api.seudominio.com npm --prefix apps/web run build
cp infra/cloudflare/pages-headers apps/web/dist/_headers
npx wrangler pages deploy apps/web/dist --project-name SEU_PROJETO
```

Também há workflow manual de Pages com environment `production`. Não foi
disparado nesta implementação. Backup e restauração controlada:

```bash
make backup
make restore-test
PHOTOINTEL_COMPOSE_MODE=prod make backup
```

O dump inclui inteligência/metadados da aplicação; não é backup dos originais
no iCloud nem dos objetos R2. Consulte [OPERATIONS.md](../OPERATIONS.md).

## E. Configuração

Os catálogos completos, sem credenciais reais, são `.env.example` e
`.env.runtime.example`. `make setup` gera segredos locais aleatórios, modo 0600.
Produção não aceita auth local nem backend de inferência de teste.

- Aplicação: `APP_ENV`, `AUTH_MODE`, `FRONTEND_ORIGIN`, `API_ORIGIN`, `LOG_LEVEL`.
- Banco: `DATABASE_URL`, `APP_DATABASE_URL`, `MIGRATION_DATABASE_URL`; papel de
  aplicação separado das credenciais de migração/admin.
- Storage: `STORAGE_BACKEND`, `STORAGE_ENDPOINT`, `STORAGE_BUCKET`,
  `STORAGE_REGION`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`.
- Access: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUDIENCE`, `ACCESS_ALLOWED_EMAILS`,
  `CORS_ORIGINS`; Tunnel em `CLOUDFLARE_TUNNEL_TOKEN`.
- iCloud: `ICLOUD_ACCOUNT`, `ICLOUD_LIBRARY`, diretórios de sessão/download,
  `INGESTION_IMPORT_LIMIT`, `INGESTION_INTERVAL_MINUTES` e limites de bytes.
- AI: `GPU_ENABLED`, `INFERENCE_BACKEND`, `JOYTAG_MODEL_REVISION`,
  `SIGLIP_MODEL_REVISION`, thresholds, batch/concurrency e budgets.
- Modal: `MODAL_ENDPOINT`, `MODAL_TOKEN`, `MODAL_PROXY_KEY`, `MODAL_PROXY_SECRET`;
  os tokens administrativos nunca entram na PWA.
- Bridge: `BRIDGE_TOKEN_PEPPER`, códigos de uso único, credenciais de dispositivo
  e Service Auth no Keychain; `APPLE_BULK_WRITE_ENABLED=false` por padrão.
- Pages: somente configuração pública `VITE_API_BASE_URL` no bundle; nunca
  credenciais Apple/R2/Modal/PostgreSQL em variáveis `VITE_*`.

## F. Testes e medições

[VALIDATION.md](VALIDATION.md) registra comandos executados, counts, falhas e
limitações com links para os runs. Os artifacts incluem JUnit, logs sintéticos,
capturas reais e outcomes individuais. Medições SQL com 176 mil metadados e
10 mil vetores estão em `docs/evidence`; não equivalem a um teste de carga
concorrente com a biblioteca pessoal inteira.

## G. Checklist inteiramente pelo iPhone

1. Abra GitHub/Codespaces no Safari; confira branch e os workflows de validação.
2. Use o terminal do Codespaces ou SSH com chave e fingerprint verificado.
3. Configure uma VM Linux e disco dimensionados; instale Docker/Compose.
4. Prepare arquivos 0600 e diretórios protegidos seguindo o runbook Oracle.
5. Configure R2 privado, Tunnel, Access allowlist e domínios HTTPS no dashboard.
6. Implante migrations, papel SQL limitado, API e workers; valide auth e mídia.
7. Publique Pages protegido e abra a API para autenticar sua sessão Access.
8. Autentique iCloud no terminal, verifique acesso e importe somente 100 imagens.
9. Configure Modal e limites do provedor; execute smoke numa imagem selecionada.
10. Verifique busca, filtros, duplicatas, tags e backup/restauração.
11. Instale Pyto, execute `doctor`, configure Service Auth e faça matrícula.
12. Autorize PhotoKit, envie inventário e confirme mapeamentos manualmente.
13. Keywords ficam pendentes se a API nativa não estiver disponível/verificada.
14. Adicione a PWA à tela inicial depois de validar os controles de privacidade.

Não é necessário Xcode ou Mac para o núcleo. O workflow SSH do repositório é
opcional; seus segredos Tailscale OAuth e ACL `tag:ci` pertencem ao operador.

## H. Limitações

API iCloud não oficial, sessões/2FA, APIs Apple Beta, iOS em foreground,
permissões Keychain/PhotoKit, cotas GPU e políticas dos provedores continuam
dependências externas. CPU real não valida CUDA/Modal; WebKit Linux não valida
Safari num iPhone físico; QEMU não mede performance Oracle. Nada escreve
keywords automaticamente ou apaga originais. [LIMITATIONS.md](../LIMITATIONS.md)
detalha os limites de operação e de evidência.

## I. Próximas ações necessárias

Concluir os gates de validação registrados, configurar as contas reais e
executar o cenário de aceitação com até 100 imagens. Qualquer expansão de
ingestão, gasto GPU e teste Apple precisa ser explícito. Funcionalidades futuras
não substituem a validação pendente do v1.
