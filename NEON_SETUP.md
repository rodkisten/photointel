# Neon PostgreSQL e perfis de capacidade

> **Referência arquitetural atualizada (04/11/2026, base `22c01bc`):** consulte [a arquitetura de referência](docs/architecture/DATA_AND_INFERENCE.md) para a topologia implementada, as fronteiras de segurança e as diferenças entre código e produção. Este guia preserva procedimentos e evidências históricas; confirme sempre as flags, o ambiente implantado e as permissões reais antes de executar comandos.

O banco continua compatível com PostgreSQL padrão. Neon é um destino de produção,
sem dependência de sua API proprietária. A criação do projeto e a escolha de um
plano exigem acesso à conta e autorização de cobrança; os scripts não criam um
projeto Neon automaticamente.

## Preparação pelo iPhone

1. No Safari, abra o dashboard oficial do Neon e crie um projeto na região mais
   próxima da região escolhida para Cloud Run. Verifique preços e cotas atuais.
2. Crie uma branch de teste separada da produção. Não utilize a produção para
   benchmarks sintéticos.
3. Copie a conexão **pooled** para o segredo `DATABASE_URL` e a conexão **direct**
   para `MIGRATION_DATABASE_URL` no Google Secret Manager. Use a interface de
   segredos; não cole as conexões em arquivos versionados nem em comandos de shell.
4. Ative `pgvector` pela migração da aplicação. O papel migrador precisa criar as
   extensões `vector` e `pg_trgm`. A identidade de execução cotidiana não precisa
   de permissão de DDL nem de administração de usuários.
5. Configure os valores não secretos abaixo e execute as migrações em uma tarefa
   exclusiva. Consulte [CLOUD_RUN_SETUP.md](CLOUD_RUN_SETUP.md) para os nomes dos
   recursos e a publicação dos segredos.

```dotenv
DATABASE_POOL_MODE=transaction
DATABASE_REQUIRE_TLS=true
DATABASE_POOL_SIZE=2
DATABASE_MAX_OVERFLOW=0
DATABASE_POOL_TIMEOUT_SECONDS=15
DATABASE_PROFILE=limited
CATALOG_ASSET_LIMIT=1000
INITIAL_IMPORT_LIMIT=100
GPU_ENABLED=false
ICLOUD_ENABLED=false
```

O formato aceito é `postgresql+asyncpg://...` ou `postgresql://...`; a conexão exige
TLS com verificação de CA e hostname em produção. O parâmetro `sslmode=require`
recebido no formato libpq é convertido para TLS **verificado**, assim como
`sslmode=verify-full`. `channel_binding=require` é um parâmetro libpq não suportado
por asyncpg e causa erro claro: remova esse parâmetro e use TLS verificado. Não
utilize uma configuração que ignore certificados.

## Pooling e orçamento de conexões

Em `DATABASE_POOL_MODE=transaction`, a aplicação usa `NullPool`, desabilita os
caches de prepared statements do cliente e gera nomes únicos. O pool externo
controla as conexões; não há um segundo pool persistente em cada instância. Não
use tabelas temporárias, estado `SET` de sessão ou advisory locks de sessão em
requisições ou workers. Locks transacionais curtos usados para coordenação de
escritas são compatíveis com esse modo.

Em `DATABASE_POOL_MODE=direct`, o pool local possui duas conexões e overflow zero
por processo, por padrão. Dimensione:

```text
pior caso aproximado = instâncias API × processos × pool_size
                    + tarefas de Jobs × processos × pool_size
                    + migração, diagnóstico e administração
```

O modo pooled reduz conexões persistentes ao servidor, mas não permite ignorar o
limite de clientes/conexões nem a capacidade de CPU do plano. Defina limites de
instâncias da API, paralelismo de Jobs e concorrência antes de liberar backfill.

## Migrações e atualização sem perda

`MIGRATION_DATABASE_URL` deve usar o endpoint **direct**, nunca `-pooler`. A tarefa
de migração usa `NullPool`, conexão direta e lock de sessão exclusivamente para
serializar migradores concorrentes. A API não aplica migrações em seu startup.

```bash
make backup
make gcp-migrate
make gcp-smoke
```

Para desenvolvimento PostgreSQL local, configure os segredos em `.env` protegido
por `make setup` e use `make migrate`. Uma revisão offline do SQL, sem conectar ao
banco, usa as mesmas variáveis de conexão já configuradas no ambiente seguro:

```bash
uv run alembic -c infra/migrations/alembic.ini upgrade head --sql
```

O migrador carrega somente configuração de banco; não requer credenciais R2,
Cloudflare, Bridge nem Modal. As migrações `0005`, `0006` e `0007` expandem o
esquema sem apagar ativos existentes. `0007_model_preprocessing` separa pipelines
com preprocessamentos incompatíveis; embeddings antigos permanecem preservados.
Downgrade pode descartar dados das novas tabelas: para
rollback de código mantenha as tabelas e restaure um backup em banco isolado antes
de decidir por qualquer downgrade.

## Perfil A: biblioteca limitada

`DATABASE_PROFILE=limited` e `CATALOG_ASSET_LIMIT=1000` constituem o perfil inicial.
O limite é uma defesa de aplicação, não uma garantia de enquadramento no plano
Free. Vetores, índices HNSW, cerca de 30 tags por foto e probabilidades brutas do
JoyTag ocupam espaço adicional. Verifique o relatório real em
[CAPACITY_REPORT.md](CAPACITY_REPORT.md) e as cotas atuais do
projeto antes de ampliar. O cache de consultas mantém no máximo 10.000 entradas
por padrão, com TTL de 24 horas; reduza o limite em um banco pequeno.

O dataset de 1.000 ativos mediu 43,84 MB com resultados brutos amostrados em 1%
das fotos. A retenção dessas probabilidades para todas as fotos acrescentaria
101,38 MB nesta amostra. Esses valores são um ponto de partida, sem margem para
novas revisões, WAL, manutenção, crescimento ou o cache completo de consultas.
Se a cota contratada for, por exemplo, 500 MB, 1.000 fotos podem caber com controle
de crescimento; o dataset de 10.000 fotos, projetado em 1,24 GB com retenção bruta,
já excederia essa cota. **500 MB é um exemplo de orçamento, não uma afirmação sobre
o plano gratuito atual do Neon.** Consulte a cota efetiva no dashboard.

## Perfil B: biblioteca completa

Use `DATABASE_PROFILE=full` e um `CATALOG_ASSET_LIMIT` explicitamente escolhido
somente após verificar espaço, performance, backup e cobrança. Para 176.000+
imagens, o plano deve comportar o catálogo, índices, retenção de resultados,
histórico, crescimento e margem operacional. Não suponha que Neon Free comporte
esta biblioteca. PostgreSQL próprio ou outro provedor continua sendo uma opção;
`pg_dump`, `pg_restore` e as migrações preservam a portabilidade.

A mudança de perfil não autoriza automaticamente uma importação: limites por
execução, confirmação de expansão e gates de validação continuam em vigor.

## Verificação e diagnóstico

```sql
SELECT version();
SELECT extversion FROM pg_extension WHERE extname = 'vector';
SELECT version_num FROM alembic_version;
SELECT pg_database_size(current_database());
SELECT relname,
       pg_relation_size(relid) AS heap_bytes,
       pg_indexes_size(relid) AS indexes_bytes,
       pg_total_relation_size(relid) AS total_bytes
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
SELECT count(*) FROM pg_stat_activity WHERE datname = current_database();
```

Use o dashboard Neon para compute/storage/conexões e `EXPLAIN (ANALYZE, BUFFERS)`
para consultas importantes. Uma primeira consulta observada não demonstra cache
frio real. Um banco que acorda após suspensão pode ter latência adicional;
`pool_pre_ping`, timeouts e retries de Jobs tratam falhas transitórias sem repetir
operações não idempotentes automaticamente.

Testes locais verificam a configuração pooled, TLS, concorrência e persistência
em PostgreSQL/pgvector. A conectividade com Neon, certificados do projeto,
PgBouncer hospedado, limites reais e cold starts exigem um projeto configurado e
continuam sendo uma verificação externa.
