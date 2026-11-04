# Documentação técnica do Photo Intelligence Cloud

**Referência de arquitetura | revisão do código de `main` em 04/11/2026 | base: `22c01bc86ce789dde937a5d215c54740ca6b93f6`**

Esta página é a entrada para a arquitetura **implementada no repositório**. Contratos e caminhos foram conferidos contra módulos, manifests, workflows e arquivos de configuração. Isso **não** certifica que os provedores externos estejam saudáveis ou que a configuração atualmente implantada coincida com o código.

## Guia de leitura

| Pergunta | Documento |
|---|---|
| Como todos os serviços se comunicam? | [Visão geral e fronteiras](architecture/SYSTEM_OVERVIEW.md) |
| Quais linguagens, bibliotecas, módulos e responsabilidades existem? | [Componentes e stack](architecture/COMPONENTS_AND_STACK.md) |
| Como uma foto passa do iCloud até previews e buscas? | [Ingestão e recuperação](architecture/INGESTION_AND_RECOVERY.md) |
| Como Cloudflare, GCP, Neon, R2 e Modal são configurados e publicados? | [Infraestrutura e deploy](architecture/INFRASTRUCTURE_AND_DEPLOY.md) |
| Onde vivem dados, vetores e modelos? | [Dados e inferência](architecture/DATA_AND_INFERENCE.md) |
| Onde são verificadas identidades e segredos? | [Segurança e segredos](architecture/SECURITY_AND_SECRETS.md) |
| Como investigar falhas, jobs, custos e notificações? | [Observabilidade e operação](architecture/OBSERVABILITY_AND_OPERATIONS.md) |
| Como funcionam interfaces, PWA e Bridge? | [Frontends e Apple Bridge](architecture/FRONTENDS_AND_BRIDGE.md) |
| Quais arquivos comprovam cada comportamento e o que falta validar? | [Mapa de implementação e lacunas](architecture/IMPLEMENTATION_REFERENCE.md) |

## Referências operacionais preexistentes

Os guias [Cloud Run](../CLOUD_RUN_SETUP.md), [Cloudflare](../CLOUDFLARE_SETUP.md), [Neon](../NEON_SETUP.md), [Modal](../MODAL_SETUP.md), [iCloud](../ICLOUD_SETUP.md), [sessões](../ICLOUD_SESSION_SETUP.md), [operações](../OPERATIONS.md), [recuperação](../DISASTER_RECOVERY.md), [custos](../COST_MODEL.md) e [limitações](../LIMITATIONS.md) continuam úteis para procedimentos específicos. Em conflito com afirmações antigas sobre Pages, cron, gates, workflows ou disponibilidade, dê precedência **ao código na versão implantada** e a esta referência datada.

A pasta [audit](audit/) contém **evidência histórica**. Relatórios v1.1 e JSONs de benchmarks não devem ser reinterpretados como prova de implantação ou testes feitos em 04/11/2026.

## Convenções de confiança

- **Implementado:** módulo, endpoint, schema ou workflow presente no commit auditado.
- **Configurável:** caminho de código existente, dependente de segredos, flags, permissões ou recursos externos.
- **Verificado localmente:** apenas quando um teste/relatório identificável realmente cobre o comportamento.
- **Não verificado em produção:** requer execução e telemetria do ambiente real; a presença de workflow não basta.
- **Planejado:** pedido de produto sem rota/módulo compatível comprovado; nunca apresentá-lo como entregue.

Na mudança de qualquer contrato ou infraestrutura, atualize o documento de arquitetura correspondente, os guias afetados e o índice de rastreabilidade. Não incluir valores reais de tokens, cookies, credenciais, URLs assinadas, e-mails privados ou conteúdo de fotos.
