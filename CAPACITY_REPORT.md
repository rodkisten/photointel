# Capacidade do catálogo v1.1

> **Nota de revisão arquitetural (04/11/2026):** As medidas de capacidade são evidências do dataset/ambiente descritos no relatório, **não** cota garantida de Neon, Cloud Run, Apple ou R2. Reavalie índices pgvector/HNSW, conexões e armazenamento para o catálogo de produção. Veja [implementação e fluxogramas](docs/architecture/DATA_AND_INFERENCE.md).

Medições locais de desenvolvimento em 19/10/2026. O catálogo de 100.000 ativos
foi populado e consultado com vetores completos e 30 tags por foto. A execução
de 176.000 ativos **não ocorreu**: a preflight recusou a criação do banco para
preservar espaço para os testes funcionais. Não há validação de capacidade do
Neon ou de execução no Cloud Run.

## Dados medidos e projeções

Os tamanhos abaixo usam MB/GB decimais. "Retenção completa" acrescenta a
projeção das probabilidades JoyTag para as 99% das fotos que não receberam esse
payload no fixture. Essa coluna **não é uma medição** de retenção completa.

| Ativos | Associações de tags | Banco medido | Com retenção bruta completa, projetado | Evidência |
| --- | ---: | ---: | ---: | --- |
| 1.000 | 30.000 | 43,84 MB | 145,22 MB | [JSON](docs/evidence/capacity-v11-1000.json) |
| 10.000 | 300.000 | 287,21 MB | 1,240 GB | [JSON](docs/evidence/capacity-v11-10000.json) |
| 100.000 | 3.000.000 | 2,696 GB | 12,176 GB | [JSON parcial](docs/evidence/capacity-v11-100000-failed-api.json) |
| 176.000 | Não geradas | Não medido | 21,429 GB por extrapolação de 100k | [Preflight](docs/evidence/capacity-v11-176000.json) |

Para 176.000 ativos, 21,429 GB é uma extrapolação linear do fixture de 100k,
incluindo retenção bruta completa projetada. Não representa o tamanho medido
de um banco de 176k. Os resultados mostram por que considerar somente os
540.672.000 bytes numéricos dos vetores float32 subestima a capacidade necessária.

O banco de 100k contém 1,410 GB em `asset_tags`, 853,87 MB em `embeddings`
(incluindo TOAST e índices), 146,10 MB em `asset_resources`, 106,27 MB em `assets`,
95,80 MB em `inference_runs` com apenas 1% dos resultados brutos e 45,17 MB em
`jobs`. O fixture possui um histórico pequeno; revisões repetidas de inferência,
novos modelos, auditoria e mais jobs aumentam esses valores.

## Método e alcance

O script [capacity-benchmark.py](infra/scripts/capacity-benchmark.py) cria um banco
novo `photointel_capacity_<uuid>`, aplica as migrações, popula dados sintéticos e
remove somente esse banco no `finally`. Exige um PostgreSQL local e a confirmação
literal `SYNTHETIC_ONLY`; recusa endpoints Neon, nomes de poolers e
`APP_ENV=production`. Nenhuma imagem privada, GPU ou recurso cloud é utilizado.

O fixture inclui:

- Um vetor normalizado float32 de 768 dimensões por foto e HNSW `m=16`,
  `ef_construction=64`.
- 30 associações de tags por foto, vocabulário de 1.000 tags e metadados técnicos.
- Três registros de derivados e um job por foto, álbum com 5% dos ativos e uma
  revisão de metadados para 10% deles.
- Até 100 grupos de duplicatas e até 1.000 embeddings de consultas.
- Todas as 5.813 probabilidades sintéticas JoyTag em **1%** das fotos. O crescimento
  real dessa tabela é medido; a retenção integral é projetada separadamente.

Isso é um teste de forma e volume de dados. Os vetores aleatórios não medem a
qualidade de busca de um modelo. O fixture não reproduz todo o histórico futuro,
nem grava conteúdo de objetos em R2. Os tamanhos dos derivados em seus registros
são estimativas de armazenamento externo, não bytes transferidos.

O ambiente compartilhado tinha 3 CPUs visíveis, cgroup limitado a 2 CPUs e
8 GiB, PostgreSQL 16.15 e pgvector 0.8.7. A configuração e amostras de CPU,
memória e conexões estão nos JSONs e em
[capacity-v11-environment.json](docs/evidence/capacity-v11-environment.json).
Os monitores do contêiner incluem atividade de outros bancos; isso impede
atribuir toda a utilização ao benchmark.

## Consultas e concorrência

Resultados do fixture de 100k, com aquisição de uma conexão local incluída por
operação. São 5 amostras simples; percentis desse grupo são exploratórios. Os
grupos com concorrência 20 contêm 100 amostras e incluem p99 no JSON.

| Consulta SQL | p50 sem concorrência | p95 sem concorrência | p95 com 20 clientes |
| --- | ---: | ---: | ---: |
| Galeria por cursor | 10,25 ms | 12,35 ms | Não medido |
| Filtros de metadados | 8,92 ms | 10,95 ms | Não medido |
| Filtro por tag | 21,43 ms | 25,24 ms | Não medido |
| Facets agregadas | 824,35 ms | 864,80 ms | 11.924,01 ms |
| Álbum | 22,37 ms | 23,47 ms | Não medido |
| ANN por embedding | 10,95 ms | 13,81 ms | 180,03 ms |
| Vetor com filtros | 12,77 ms | 22,08 ms | 205,94 ms |
| Claim de job | 7,53 ms | 10,27 ms | Não medido nesse snapshot |

Também foram medidos 1 e 5 clientes para ANN, busca híbrida e facets. Os JSONs
contêm `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, latências, throughput e contagens.
O harness atual adiciona a disputa por claims de jobs ao conjunto concorrente.
A primeira observação é identificada como `first_observed_ms`; não houve
limpeza de caches, reinício isolado do banco nem medição de cold start Neon.

Facets sob concorrência 20 são um gargalo demonstrado nesse fixture: p95 de
11,9 segundos e cerca de 1,94 consultas/s. Isso não satisfaz uma experiência
interativa rápida. Antes de aprovar o backfill completo, meça a consulta real
da API no destino e avalie agregações limitadas/cache com invalidação por revisão.
Não há um SLA validado para 176k.

A população de 100k observou cerca de 4.366 ativos/s, 20.716 associações de
tags/s e 803 vetores/s. O HNSW levou 446,82 s com `maintenance_work_mem=64MB`.
Essas são fases isoladas de escrita local, sem iCloud ou inferência. Não permitem
estimar tempo de importação da biblioteca pessoal.

## Execuções parciais e falhas preservadas

1. **1k e 10k:** harness concluído com migração `0006_query_embedding_cache`.
   A API local respondeu a galeria e similaridade; houve respostas 429 sob carga.
   O bloco de filtros de metadados foi inteiramente limitado por rate limiting:
   ele não é evidência de throughput de filtros bem-sucedidos. O harness atual
   usa IPs reais de loopback separados por cenário e exige HTTP 200 no baseline.
2. **100k, tentativa inicial:** PostgreSQL reportou `DiskFull` por esgotamento de
   `/dev/shm` em hashes paralelos. Isso não demonstrou falta de cota Neon nem
   falta de espaço do volume de dados. [Log](docs/evidence/capacity-v11-100000-failed-shm.log)
   e [relatório](docs/evidence/capacity-v11-100000-failed-shm.json) foram preservados.
   O default atual desativa workers paralelos por consulta somente no banco de
   benchmark e registra essa configuração.
3. **100k, tentativa seguinte:** população, armazenamento e consultas SQL foram
   concluídos, porém a fase HTTP falhou. Esse snapshot antecede a separação de
   namespaces da migração 0007. Portanto, não é um teste end-to-end aprovado da
   API de 100k.
4. **100k, namespace atual:** a migração 0007 aplicou, mas a execução foi
   interrompida por SIGTERM quando builds e testes funcionais disputaram disco.
   O `finally` removeu o banco próprio. [JSON](docs/evidence/capacity-v11-100000.json)
   registra `status=interrupted`, sem reaproveitar resultados de outra tentativa.
5. **176k:** a preflight observou 5.760.913.408 bytes livres; o fixture estimado
   em 5.632.000.000 bytes mais reserva de 5 GiB excederia esse espaço. Retornou
   exit code 2 e `database_created=false`. Nenhuma linha de 176k foi gerada.

Os resultados de 1k/10k e o SQL de 100k são evidências anteriores de desenvolvimento,
com seu SHA inicial, hash do script e `working_tree_dirty=true`. Não devem ser
atribuídos ao release final. Mudanças de harness e de ambiente impedem tratar
diferenças entre esses testes como uma melhoria de performance do produto.

## Precisão e alternativas de armazenamento

Em 1k, o índice experimental `halfvec(768)` ocupou 2.056.192 bytes. Uma consulta
sintética obteve overlap exato e recall aproximado @20 de 1,0. **Uma consulta
não valida a precisão de produção.** O índice foi removido após a medição;
nenhuma coluna ou busca de produção mudou para halfvec.

Resultados brutos e milhões de associações de tags dominam o crescimento.
Trocar apenas a precisão dos vetores não elimina essa pressão. Arquivamento
privado e versionado de probabilidades pode ser avaliado futuramente, mas não
é apresentado aqui como funcionalidade já implementada. A retenção atual exige
planejar capacidade para os resultados e evitar purgas silenciosas.

## Recomendação para Neon

| Biblioteca | Recomendação |
| --- | --- |
| 1.000 | Perfil `limited`; elegível a um plano pequeno somente se a cota real comportar aproximadamente 145 MB projetados, cache e margem. |
| 10.000 | Cerca de 1,24 GB projetados antes de margem; não cabe em uma cota de exemplo de 500 MB. |
| 100.000 | Cerca de 12,18 GB projetados antes de margem; planejar plano maior ou PostgreSQL portável com capacidade correspondente. |
| 176.000 | Sem medição integral; extrapolação de 21,43 GB antes de margem, com capacidade/latência ainda pendentes de validação. |

Uma margem ilustrativa de 50% sobre a projeção completa de 176k exigiria cerca de
32,14 GB, ainda sem definir retenção de WAL, novas revisões e crescimento futuro.
Isso é planejamento, não uma especificação de plano nem orçamento contratado.
O exemplo de cota de 500 MB não afirma que esse seja o limite atual do Neon Free;
verifique o dashboard e a tabela oficial vigente. O limite padrão de 1.000 ativos
protege a aplicação, mas não substitui monitoramento de quota.

Consulte [NEON_SETUP.md](NEON_SETUP.md) para TLS, endpoint pooled de runtime e
endpoint direct de migração, e [COST_MODEL.md](COST_MODEL.md) para custos.

## Como reproduzir sem afetar produção

Prepare um PostgreSQL/pgvector local descartável. Configure
`CAPACITY_ADMIN_DATABASE_URL` por um mecanismo privado, sem colocar a URL no
histórico do terminal, nos argumentos ou em arquivos versionados. Nunca use
o endpoint Neon de produção. Execute os tamanhos **sequencialmente**:

```bash
for size in 1000 10000 100000 176000; do
  uv run python infra/scripts/capacity-benchmark.py \
    --assets "$size" --samples 5 \
    --confirm-disposable SYNTHETIC_ONLY \
    --postgres-container photointel-v11-postgres \
    --output "reports/capacity-$size.json"
done
```

O default mantém `maintenance_work_mem=64MB`, queries sem paralelismo PostgreSQL,
workers de manutenção zero e reserva estimada de 5 GiB. Para um host dedicado
com RAM e disco verificados, `--maintenance-work-mem-mib 512` modifica apenas o
banco descartável. `--halfvec` habilita a comparação experimental adicional.

A preflight é uma estimativa do filesystem local, não uma reserva atômica de
disco nem uma leitura da quota do servidor. Verifique o volume PostgreSQL real,
evite builds pesados simultâneos e mantenha monitoramento. SIGTERM permite
cleanup; SIGKILL ou falha do host exigem localizar pelo nome o banco próprio e
confirmar sua identidade antes de qualquer remoção. Não execute um `DROP` em
bancos da aplicação.
