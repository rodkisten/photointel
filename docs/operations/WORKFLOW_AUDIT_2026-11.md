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

## Segunda etapa implementada

- `release-manifest.yml`: somente manual; remove execução automática para cada mudança de código.
- `webkit-validation.yml`: somente manual; mantém teste WebKit disponível sob demanda.
- `container-architectures.yml`: somente manual; evita builds multiplataforma automáticos custosos.
- `compose-validation.yml`: somente manual; evita subir infraestrutura Docker em pushes comuns.
- `real-cpu-smoke.yml`: somente manual; impede downloads pesados automáticos de modelos.
- `backend-smoke.yml`: mantém validação em PR/push, com nome/run-name padronizados.

**Observação:** a auditoria de todos os workflows e a análise dos consumidores ainda não estão concluídas. Não foram removidos deploys, Terraform ou migrações.

## Terceira etapa: superfícies de deploy

Inspecionados os YAMLs de `release.yml`, `gcp-deploy.yml`, `github-image-build.yml` e `media-deploy.yml`.

- `release.yml` é um console que chama `infra.terraform.release_console`, com seleção de origem, ação e destino. Continua sendo entrada principal.
- `gcp-deploy.yml` possui caminho de deploy de API, migration e scheduler, além de um check offline de push. Não é equivalente ao console de release, pois seus parâmetros e proteções são diferentes.
- `github-image-build.yml` publica imagens de API e media no Artifact Registry e reutiliza imagens existentes. Ainda pode ser chamado diretamente por operadores e precisa de avaliação de consumidores antes de arquivamento.
- `media-deploy.yml` constrói e valida os serviços media e despacha Terraform; é distinto do build isolado de imagem.

Padronizados nomes e run-name dos três primeiros e `tf-production.yml`, sem alterar a lógica de deploy ou permissões. **Não remover os workflows de deploy até confirmar que `release_console.py` cobre cada ação e os contratos com o Manage.**

## Quarta etapa: gatilhos e correlação do console

- `release.yml`: removido push automático de verificação e job de check redundante; console agora é entrada manual de produção.
- `gcp-deploy.yml`: removido push automático de verificação offline, preservadas ações manuais e seus controles de produção.
- `deploy-worker.yml`: nomes de execução padronizados para Cloudflare (PR, push e dispatch).
- `infra/terraform/release_console.py`: atualizada a identificação de execuções disparadas do Cloudflare para acompanhar o novo run-name. **A correlação por título ainda é frágil e deve evoluir para request_id quando a API permitir.**

As validações offline continuam em workflows próprios (`ci.yml`, `gcp-validation.yml`, `tf-validate.yml`), mas a cobertura exata dos checks removidos precisa ser confirmada antes do merge. Nenhum workflow de deploy foi excluído.
