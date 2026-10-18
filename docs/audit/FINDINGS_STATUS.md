# Situação dos achados

Inspeção inicial; resultados serão atualizados após correção e execução.

## P0-01 — Expansão de importação

- Severidade: P0.
- Estado atual: Confirmado.
- Causa raiz: API confirma limite; ingest_icloud aplica min com limite inicial.
- Componentes: API, serviços, persistência, interface e infraestrutura conforme o achado.
- Correção: implementar etapa correspondente do plano, preservando contratos.
- Regressão: cenário obrigatório do prompt, incluindo erro/retry/limite quando aplicável.
- Evidência: pendente de execução v1.1; evidências v1 não são validação desta release.
- Resultado final: em implementação.

## P0-02 — Falha isolada

- Severidade: P0.
- Estado atual: Confirmado.
- Causa raiz: Download integrado à descoberta relança erro e reverte lote.
- Componentes: API, serviços, persistência, interface e infraestrutura conforme o achado.
- Correção: implementar etapa correspondente do plano, preservando contratos.
- Regressão: cenário obrigatório do prompt, incluindo erro/retry/limite quando aplicável.
- Evidência: pendente de execução v1.1; evidências v1 não são validação desta release.
- Resultado final: em implementação.

## P0-03 — Transações longas

- Severidade: P0.
- Estado atual: Confirmado.
- Causa raiz: Worker usa transação e advisory lock durante I/O externo.
- Componentes: API, serviços, persistência, interface e infraestrutura conforme o achado.
- Correção: implementar etapa correspondente do plano, preservando contratos.
- Regressão: cenário obrigatório do prompt, incluindo erro/retry/limite quando aplicável.
- Evidência: pendente de execução v1.1; evidências v1 não são validação desta release.
- Resultado final: em implementação.

## P0-04 — Keywords Apple

- Severidade: P0.
- Estado atual: Limitação confirmada.
- Causa raiz: Adapter nativo indisponível; falta validação em hardware.
- Componentes: API, serviços, persistência, interface e infraestrutura conforme o achado.
- Correção: implementar etapa correspondente do plano, preservando contratos.
- Regressão: cenário obrigatório do prompt, incluindo erro/retry/limite quando aplicável.
- Evidência: pendente de execução v1.1; evidências v1 não são validação desta release.
- Resultado final: em implementação.

## P0-05 — Gates reais

- Severidade: P0.
- Estado atual: Confirmado.
- Causa raiz: Evidência local/CPU existe; iCloud/Modal live não comprovados.
- Componentes: API, serviços, persistência, interface e infraestrutura conforme o achado.
- Correção: implementar etapa correspondente do plano, preservando contratos.
- Regressão: cenário obrigatório do prompt, incluindo erro/retry/limite quando aplicável.
- Evidência: pendente de execução v1.1; evidências v1 não são validação desta release.
- Resultado final: em implementação.

## P1-01 — Configuração

- Severidade: P1.
- Estado atual: Parcialmente corrigido.
- Causa raiz: Flags conservadoras existem; biblioteca default e novas flags exigem revisão.
- Componentes: API, serviços, persistência, interface e infraestrutura conforme o achado.
- Correção: implementar etapa correspondente do plano, preservando contratos.
- Regressão: cenário obrigatório do prompt, incluindo erro/retry/limite quando aplicável.
- Evidência: pendente de execução v1.1; evidências v1 não são validação desta release.
- Resultado final: em implementação.

## P1-02 — Backfill

- Severidade: P1.
- Estado atual: Confirmado.
- Causa raiz: Offset móvel e repetição de head em rotações.
- Componentes: API, serviços, persistência, interface e infraestrutura conforme o achado.
- Correção: implementar etapa correspondente do plano, preservando contratos.
- Regressão: cenário obrigatório do prompt, incluindo erro/retry/limite quando aplicável.
- Evidência: pendente de execução v1.1; evidências v1 não são validação desta release.
- Resultado final: em implementação.

## P1-03 — Integridade de cache

- Severidade: P1.
- Estado atual: Confirmado.
- Causa raiz: Arquivo completo é reutilizado apenas por tamanho.
- Componentes: API, serviços, persistência, interface e infraestrutura conforme o achado.
- Correção: implementar etapa correspondente do plano, preservando contratos.
- Regressão: cenário obrigatório do prompt, incluindo erro/retry/limite quando aplicável.
- Evidência: pendente de execução v1.1; evidências v1 não são validação desta release.
- Resultado final: em implementação.

## P1-04 — Cloud Run e Neon

- Severidade: P1.
- Estado atual: Ausente.
- Causa raiz: Destino atual depende de VPS e loops persistentes.
- Componentes: API, serviços, persistência, interface e infraestrutura conforme o achado.
- Correção: implementar etapa correspondente do plano, preservando contratos.
- Regressão: cenário obrigatório do prompt, incluindo erro/retry/limite quando aplicável.
- Evidência: pendente de execução v1.1; evidências v1 não são validação desta release.
- Resultado final: em implementação.

## P1-05 — Capacidade Neon

- Severidade: P1.
- Estado atual: Ausente.
- Causa raiz: Benchmark não mede densidade completa/cotas.
- Componentes: API, serviços, persistência, interface e infraestrutura conforme o achado.
- Correção: implementar etapa correspondente do plano, preservando contratos.
- Regressão: cenário obrigatório do prompt, incluindo erro/retry/limite quando aplicável.
- Evidência: pendente de execução v1.1; evidências v1 não são validação desta release.
- Resultado final: em implementação.

## P1-06 — Benchmark representativo

- Severidade: P1.
- Estado atual: Parcial.
- Causa raiz: 176k metadata; somente10k vetores e baixa densidade.
- Componentes: API, serviços, persistência, interface e infraestrutura conforme o achado.
- Correção: implementar etapa correspondente do plano, preservando contratos.
- Regressão: cenário obrigatório do prompt, incluindo erro/retry/limite quando aplicável.
- Evidência: pendente de execução v1.1; evidências v1 não são validação desta release.
- Resultado final: em implementação.

## P1-07 — Cache de texto

- Severidade: P1.
- Estado atual: Confirmado.
- Causa raiz: Embedding remoto por consulta sem cache PostgreSQL.
- Componentes: API, serviços, persistência, interface e infraestrutura conforme o achado.
- Correção: implementar etapa correspondente do plano, preservando contratos.
- Regressão: cenário obrigatório do prompt, incluindo erro/retry/limite quando aplicável.
- Evidência: pendente de execução v1.1; evidências v1 não são validação desta release.
- Resultado final: em implementação.

## P1-08 — Backup de objetos

- Severidade: P1.
- Estado atual: Confirmado.
- Causa raiz: Dump/manifesto não preservam conteúdo R2.
- Componentes: API, serviços, persistência, interface e infraestrutura conforme o achado.
- Correção: implementar etapa correspondente do plano, preservando contratos.
- Regressão: cenário obrigatório do prompt, incluindo erro/retry/limite quando aplicável.
- Evidência: pendente de execução v1.1; evidências v1 não são validação desta release.
- Resultado final: em implementação.

## P1-09 — Safari físico

- Severidade: P1.
- Estado atual: Limitação confirmada.
- Causa raiz: WebKit Linux não valida iPhone físico.
- Componentes: API, serviços, persistência, interface e infraestrutura conforme o achado.
- Correção: implementar etapa correspondente do plano, preservando contratos.
- Regressão: cenário obrigatório do prompt, incluindo erro/retry/limite quando aplicável.
- Evidência: pendente de execução v1.1; evidências v1 não são validação desta release.
- Resultado final: em implementação.
