# Photo Intelligence Cloud v1.0

Catálogo privado de fotos e vídeos, preparado para bibliotecas grandes, com tags
revisáveis, busca textual e vetorial, álbuns, fila persistente, diagnóstico de
duplicatas e integração opcional com iCloud. Os originais permanecem no serviço
de origem: o projeto trabalha com representações limitadas e derivados privados.

O núcleo funciona em Linux ARM64/AMD64 sem Mac, Xcode ou aplicativo iOS próprio.
O iPhone pode acessar a PWA e operar o servidor por SSH. A ponte Pyto é opcional;
as capacidades reais do dispositivo e qualquer escrita de keywords precisam de
validação e aprovação. Leia [LIMITATIONS.md](LIMITATIONS.md) antes de conectar
uma biblioteca pessoal.

## Início local

Requisitos: Python 3.12, uv, Node 22, Docker com Compose v2, armazenamento livre
e acesso aos registros de pacotes/imagens. Em Codespaces, abra o repositório com
`.devcontainer/devcontainer.json` e mantenha as portas encaminhadas **privadas**.

```bash
make setup                    # .env 0600, segredos locais aleatórios, dependências
make dev                      # banco, MinIO, migração, API, worker, ingestion, web
make seed ASSETS=100           # apenas mídias sintéticas
make doctor
```

Abra `http://localhost:5173`; a API usa `http://localhost:8000`. Banco e MinIO
escutam somente em loopback no modo local. O bucket é privado. `make stop`
preserva os volumes; não use `docker compose down -v` em uma biblioteca real.

O modo de autenticação local serve ao desenvolvimento em loopback. Produção
exige JWT criptograficamente validado do Cloudflare Access, allowlist explícita,
HTTPS e R2/S3 privado. [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md) e
[docs/deployment/oracle-arm.md](docs/deployment/oracle-arm.md) descrevem a instalação.

## Comandos

| Comando | Resultado/pré-requisito |
|---|---|
| `make setup` | Preserva `.env` existente; instala dependências dos lockfiles |
| `make dev` | Compila e inicia o ambiente Compose local |
| `make migrate` | Aplica Alembic no banco de `DATABASE_URL` |
| `make seed ASSETS=100` | Com Compose ativo, cria mídias sintéticas no volume compartilhado; não lê iCloud |
| `make lint`, `make typecheck` | Verificações Python e TypeScript |
| `make test` | Testes sem integrações externas e testes do frontend |
| `make test-integration` | PostgreSQL real; serviço correspondente precisa estar disponível |
| `make test-e2e` | Playwright; navegador e aplicação precisam estar disponíveis |
| `make build` | Bundle web e imagens API/frontend |
| `make doctor` | Diagnóstico em JSON; integração não configurada é explicitada |
| `make ingest-test` | Exercício do pipeline com fixture sintética |
| `make gpu-test` | Testes marcados GPU; modelos/revisões/hardware reais necessários |
| `make backup` | `pg_dump`, exportação CSV/JSON e hashes; requer Compose ativo |
| `make restore-test` | Backup/restore de dois bancos sintéticos isolados |
| `make export` | CSV/JSON em `exports/`, sem vetores volumosos |
| `make benchmark ASSETS=10000` | Benchmark em banco sintético, relatório JSON |
| `make cleanup` | Remove somente arquivos temporários expirados em `var/processing` |

GPU e iCloud começam desativados. Os limites iniciais são lote 8, concorrência 1,
importação 100 mídias, até 20 MiB por download e varredura a cada 60 minutos.
As estimativas de custo restringem agendamento; não substituem limites ou alertas
de cobrança do provedor. Revise [docs/MODAL_SETUP.md](docs/MODAL_SETUP.md).

## Documentação e evidência

- [ARCHITECTURE.md](ARCHITECTURE.md): componentes, identidade e fluxos.
- [DATABASE.md](DATABASE.md): entidades, índices, evolução e backup.
- [API.md](API.md): autenticação, paginação e contrato HTTP.
- [ICLOUD_SETUP.md](ICLOUD_SETUP.md): login interativo e sessões protegidas.
- [PYTO_BRIDGE.md](PYTO_BRIDGE.md): capacidades e aprovação no dispositivo.
- [OPERATIONS.md](OPERATIONS.md): operação diária, recuperação e custos.
- [docs/operations/benchmarks.md](docs/operations/benchmarks.md): medições reproduzíveis.
- [LIMITATIONS.md](LIMITATIONS.md): limitações externas e critérios de validação.
- [docs/VALIDATION.md](docs/VALIDATION.md): testes e medições realmente executados.
- [docs/DELIVERY.md](docs/DELIVERY.md): mapa, matriz de capacidades, comandos e checklist iPhone.

Arquivos `reports/` são evidência apenas quando produzidos por uma execução
real. A presença de um workflow, configuração ou teste não significa implantação,
benchmark ou integração Apple/Modal concluída. Nunca publique fotos, cookies,
credenciais ou relatórios com metadados pessoais em um repositório público.
