# Worker PostgreSQL

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
