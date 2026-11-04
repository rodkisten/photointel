# Worker PostgreSQL

> **Nota de revisão arquitetural (04/11/2026):** Esta pasta não contém um executável de worker separado. A fila durável, leases, claims e execução vivem em `apps/api/src/photointel/services/jobs.py`, `worker.py`, `task_runner.py` e no PostgreSQL. Confira [a referência de código e fluxos](../../docs/architecture/INGESTION_AND_RECOVERY.md).

```bash
uv run python -m photointel.services.worker
```

Jobs são adquiridos por `FOR UPDATE SKIP LOCKED`, têm heartbeat, lease, tentativas,
backoff exponencial e chave idempotente única. O resultado e o evento de conclusão
são confirmados em uma transação que verifica novamente worker, status e lease.
Cancelamento ou perda de lease causa rollback. Recursos externos usam chaves
determinísticas, permitindo replay após crash. Workers fazem shutdown limitado e
leases expirados são recuperados sem intervenção. Batches pausados não são
adquiridos. SSE lê `job_events`, sem depender de processos vivos na PWA.

`metadata_extract` decodifica uma vez, persiste metadados, métricas, hashes e as
quatro variantes privadas; jobs separados verificam cada etapa persistida, evitando
repetir decodificação. A análise de duplicatas é não destrutiva e usa candidatos
limitados por índices; resultados são sugestões, sem merge ou remoção de assets.
Inferência desabilitada não bloqueia previews e deixa o estado `not_configured`.

## Revisões e recuperação de derivados

Cada etapa automática carrega a revisão de conteúdo esperada. Jobs antigos são
concluídos como `skipped` quando o asset já mudou, sem inferir a representação
errada. Um batch GPU tem um heartbeat PostgreSQL para todos os seus jobs e
conexões curtas independentes do pool ocupado por processamento. As métricas
agregadas ficam em um job do batch; os demais referenciam esse registro.

Uma solicitação explícita de reindexação pode reconstruir thumbnails ou métricas
usando o cache ainda disponível. Depois de retirar o cache, o preview privado
permite recuperar thumbnails e métricas identificadas como derivadas de preview.
O SHA-256 de origem é preservado; não se afirma ter recalculado o hash de uma
representação que já não está armazenada. A remoção de cache exige preview
persistente existente e não concorre com um processamento que detenha o lock do
asset. Alterações de representação invalidam agrupamentos derivados antigos,
sem excluir fotos, recursos persistentes ou metadados originais.

Verificações restritas, sem dependências externas:

```bash
python tests/worker_core_smoke.py
```

Esse comando executa funções reais extraídas do código por AST e transportes
controlados de teste. Ele verifica limites de download, retomada, isolamento de
sessão e fronteira de threads. Não substitui Pytest nem confirma PostgreSQL,
object storage, autenticação Apple ou inferência GPU.
