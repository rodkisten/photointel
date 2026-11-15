# Auditoria e padronização dos GitHub Actions

Data: 2026-11-14. Primeira etapa, **não é autorização para apagar workflows de produção**.

## Objetivo

Manter uma interface de operação simples para um único operador, reduzir disparos automáticos, custos e workflows com funções sobrepostas, sem perder os controles de segurança e a recuperação de infraestrutura.

## Convenção

- `name: "emoji ÁREA · Ação"` e `run-name: "emoji ÁREA · Ação · contexto curto"`.
- Categorias: `🧪 CI`, `🚀 Release`, `☁️ GCP`, `TF · Terraform`, `🌐 Cloudflare`, `🎞️ Media`, `🧠 GPU`, `🧹 Maintenance`.
- O run-name deve indicar alvo e operação para workflows manuais; PR deve mostrar número do PR. Não incluir secrets, tokens ou URLs assinadas.
- Não usar texto do nome de job/step como chave de integração; usar IDs estáveis.
- `push`/PR apenas para testes rápidos e deploys explicitamente desejados; diagnósticos, limpeza, operações pagas, migrations e provisionamento por `workflow_dispatch`.
- `environment: production` e WIF apenas para jobs que realmente acessam produção; `permissions` mínimos.
- `concurrency` deve impedir operações simultâneas incompatíveis; não cancelar Apply/deploy em andamento.
- `workflow_call` e actions compartilhadas para reutilizar passos; não replicar pipelines inteiros.

## Classificação inicial dos fluxos encontrados

| Manter como entrada principal | Papel |
|---|---|
| `ci.yml` | CI de PR e main |
| `release.yml` | Console único de build/deploy, verificar sobreposição com gcp-deploy |
| `tf-production.yml` | Plan/import/apply Terraform com proteção |
| `tf-validate.yml` | Validação offline Terraform |
| `deploy-worker.yml` | Deploy Cloudflare de frontends |
| `modal-gpu-deploy.yml` | GPU Modal independente |
| `media-deploy.yml` | Media Jobs e builds |
| `gcp-migrate.yml` | Migração de banco com confirmação |
| `gcp-health.yml` | Diagnóstico manual de produção |

| Consolidar ou revisar antes de remover | Motivo |
|---|---|
| `gcp-deploy.yml`, `release.yml`, `github-image-build.yml` | Três superfícies para build/deploy; verificar consumidores, identidades e cobertura antes de consolidar |
| `gcp-bootstrap.yml`, `tf-state-bootstrap.yml`, `tf-production.yml` | Bootstrap e Terraform têm etapas e permissões diferentes; não remover às cegas |
| `media-imagor-smoke.yml`, `media-imagor-publish.yml`, `tf-media-imagor-plan.yml` | Fluxo temporário de adoção Imagor; consolidar após deploy validado |
| `artifact-cleanup.yml`, `gcp-artifact-cleanup.yml` | Limpezas de armazenamentos distintos; manter manuais, não misturar permissões |
| `config-sync.yml`, `tf-env-package.yml`, `tf-permissions.yml` | Avaliar se já cobertos por Terraform e editor de ENV |
| `cloudflare-pr-previews.yml`, `deploy-worker.yml` | Previews vs produção; verificar lifecycle e apenas um preview por PR |

## Primeiras mudanças implementadas

- `ci.yml`: nome e run-name padronizados.
- `gcp-health.yml`: nome e run-name padronizados; diagnóstico apenas manual para evitar consultas desnecessárias em push.
- `artifact-cleanup.yml`: nome e run-name padronizados; limpeza apenas manual.
- `media-imagor-smoke.yml`: nome e run-name padronizados.

## Próxima fase obrigatória antes de exclusões

1. Inventariar todos os YAMLs atuais de `.github/workflows/` (o catálogo histórico de outubro está desatualizado).
2. Para cada workflow: `on`, inputs, environment, permissões, custos, consumidores `workflow_call`/`workflow_dispatch`/API do Manage e último uso.
3. Marcar `keep`, `merge`, `manual-only` ou `remove`; preservar workflows referenciados por Terraform, Manage e outros workflows.
4. Consolidar deploys por trás do `release.yml` sem mudar identidades WIF, contratos ou jobs existentes até testes.
5. Excluir apenas após prova de ausência de consumidores e teste da substituição, preferencialmente em PR separado.

**Segurança:** o plano de Imagor e a migração Neon não podem ser confundidos com Apply. Nunca liberar segredos de produção para PR.
