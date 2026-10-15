# Benchmarks e planos de consulta

Execute em um PostgreSQL descartável com as migrações aplicadas. Não é necessário
configurar iCloud, Modal ou GPU. A CLI recusa `APP_ENV=production`. Os dados são
sintéticos; somente um relatório produzido pela execução representa medição.

```bash
make benchmark ASSETS=10000 REPORT=reports/benchmark-10000.json
make benchmark ASSETS=100000 REPORT=reports/benchmark-100000.json
make benchmark ASSETS=176000 REPORT=reports/benchmark-176000.json
make benchmark ASSETS=500000 REPORT=reports/benchmark-500000.json
uv run python -m photointel.cli benchmark --assets 10000 --vectors 10000 \
  --timeout-seconds 600 --output reports/benchmark-vectors-10000.json
PHOTOINTEL_BENCHMARK_SYNTHETIC=1 bash infra/scripts/benchmark-matrix.sh
```

A matriz executa 10 mil, 100 mil e 176 mil registros de metadados e uma execução
separada com 10 mil vetores. Acrescente `BENCHMARK_INCLUDE_500K=1` para medir
500 mil registros de metadados quando o disco e o tempo disponíveis permitirem.
`BENCHMARK_TIMEOUT_SECONDS=600` controla o limite por execução. A CLI também
aceita `--repetitions` entre 1 e 20 e `--vectors` entre zero e
`min(assets, 50000)`. O padrão permanece sem vetores e com cinco repetições.

## O que é medido

Cada execução cria uma biblioteca em uma única transação. A CLI mede inserção de
metadados, primeira e segunda páginas por cursor, filtro de dimensão/tamanho e
busca PostgreSQL full-text. Para cada consulta ela registra as amostras de
latência observadas pelo cliente, mínimo, máximo, mediana, total retornado e
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` real. As amostras incluem consultas
repetidas com cache possivelmente aquecido; não representam um ensaio de cache
frio, concorrência ou percentis p95/p99 confiáveis com cinco amostras.

Com `--vectors`, o PostgreSQL gera vetores determinísticos de 768 dimensões com
`sincos-v1`, normalizados por `l2_normalize`, em lotes de 250. Nenhum conjunto de
vetores é carregado inteiro em Python. O registro de modelo preserva o nome,
a revisão e a dimensão configurados do SigLIP 2, mas usa um provider exclusivo
`synthetic-benchmark-*`, fica inativo e é explicitamente marcado como sintético.
A geração não executa um modelo nem mede qualidade semântica.

A inserção mede o custo com o índice HNSW existente sendo mantido. A consulta de
similaridade usa o operador de distância de cosseno diretamente na ordenação,
com filtro por modelo e limite de 20 resultados. Uma CTE `MATERIALIZED` calcula
a referência exata, também em SQL, para a mesma consulta. O relatório contém
`vector_recall_at_20` para **uma única consulta sintética**, validação da norma e
da dimensão e `ann_index_observed` com o índice efetivamente visto no plano. Um
resultado `false` significa que o planner escolheu outro caminho; o benchmark
não força índices nem apresenta essa execução como medição de HNSW. Esse
recall não avalia recuperação semântica real nem a distribuição das fotos.

## Isolamento e limites

Todas as linhas geradas, inclusive o modelo e os embeddings, são removidas por
rollback ao concluir ou falhar. O relatório informa `status`, `error_type` em
falhas, versões PostgreSQL/pgvector, `shared_buffers`, `work_mem`, quantidade de
assets preexistentes, duração e os planos. Um deadline global e o
`statement_timeout` do PostgreSQL limitam as operações. Um timeout gera relatório
parcial e encerra o comando com erro, em vez de apresentar uma medição completa.

Mesmo com rollback, a execução consome CPU, disco e WAL, pode produzir tuplas
mortas nos índices e executar `ANALYZE`; use um banco descartável e sem workers.
Não execute sobre a biblioteca privada para evitar interferência nas
estatísticas ou resultados com parâmetros pessoais em planos de consulta.
Relatórios têm permissão `0600`. A ferramenta não acessa nem remove fotografias.

Registre separadamente commit, CPU/arquitetura, RAM, disco e tamanho dos índices.
Estes ensaios não medem ainda concorrência de jobs, cache frio, distribuição real
de tags, milhares de consultas para recall ou 176 mil embeddings. O ensaio de
500 mil registros sem vetores também não comprova a capacidade da busca vetorial
com 500 mil embeddings. Os planos devem ser avaliados no hardware de destino;
a CLI não publica números preenchidos antecipadamente.
