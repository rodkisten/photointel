# Benchmarks e planos de consulta

Use banco PostgreSQL descartável. Fixtures devem ser sintéticas, sem cookies,
fotos pessoais ou credenciais no relatório. Nenhuma tabela de latência pré-preenchida
é resultado medido.

```bash
make benchmark ASSETS=10000 REPORT=reports/benchmark-10000.json
make benchmark ASSETS=100000 REPORT=reports/benchmark-100000.json
make benchmark ASSETS=176000 REPORT=reports/benchmark-176000.json
make benchmark ASSETS=500000 REPORT=reports/benchmark-500000.json
```

`infra/scripts/benchmark-matrix.sh` executa a sequência somente com
`PHOTOINTEL_BENCHMARK_SYNTHETIC=1`. A CLI registra o número de mídias sintéticas
geradas e executa as consultas na mesma transação, desfeita após a medição.
Ela mede listagem por cursor, filtro de metadados e busca textual com cinco
amostras e plano real por consulta. Mesmo com rollback, use banco descartável
para evitar concorrência, consumo de disco/WAL e interferência nas estatísticas
de uma biblioteca real.

Registre commit, data, versões PostgreSQL/pgvector, CPU/arquitetura, RAM, disco,
configuração, dimensões/revisão do modelo, tamanho de tabela/índices e total real
de assets/vetores/tags. Capture `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` para:

- Listagem por data com cursor e filtro de biblioteca/status.
- Texto e nome parcial (tsvector/trigram).
- Tags com origem/confiança e filtros compostos.
- Similaridade de vetor no modelo compatível, com seletividade e recall conhecido.
- Claim de jobs em concorrência e recuperação de lease.

Separe aquecimento de execução fria, repita amostras e reporte p50/p95/p99,
quantidade de repetições e erros. Confirme o plano realmente usado: um scan
sequencial pode ser apropriado numa fixture pequena; não force índice só para
melhorar uma apresentação. Planos de produção podem conter dados pessoais e não
devem virar artifact público. Benchmarks de catálogo sem vetores não comprovam
desempenho da busca semântica com 500 mil embeddings.
