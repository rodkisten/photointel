# P0-03 — transações curtas e recuperação do worker

A fila continua em PostgreSQL; não foi introduzido broker. A execução agora possui
três fases: preparar e confirmar descritores, executar I/O sem transação SQL aberta,
e persistir os resultados numa transação curta com verificação de revisão e posse.

## Posse e concorrência

- `jobs.fence_token` aumenta a cada aquisição. Heartbeats e resultados exigem o
  mesmo identificador do worker, token, estado ativo e lease ainda válido.
- `durable_leases` coordena assets e slots de inferência. A aquisição usa um upsert
  condicional atômico; uma conexão PostgreSQL não permanece ocupada durante o I/O.
- Os locks de linha ficam restritos à confirmação de estado e de resultados. Não
  existe lock de sessão para coordenar processamento através do pooler Neon.
- A reserva financeira é confirmada antes da chamada paga. Um resultado incerto de
  rede não restitui automaticamente o valor reservado nem autoriza gasto adicional.

## Objetos e falhas

Antes de enviar derivados ao storage, o worker confirma `object_intents`. A chave
inclui o hash dos bytes codificados: um upload antigo não substitui bytes distintos
produzidos por outro worker. Recursos, metadados e conclusão do job são confirmados
juntos depois da validação de posse e revisão.

Se o processo morrer após o upload e antes dessa confirmação, o intent permanece
recuperável. A manutenção só remove chaves registradas no outbox, sem referência
válida no catálogo, sem job ativo e após uma carência mínima de uma hora, por padrão
24 horas. Não percorre o bucket para apagar objetos desconhecidos.

Representações baixadas pelo iCloud possuem um recurso privado `source_download`.
No cold start, o processador pode reidratá-lo no filesystem efêmero. O checksum
persistido também detecta corrupção local com tamanho inalterado; o incidente é
registrado e apenas aquele arquivo de cache é substituído atomicamente.

Falhas de download e decodificação atualizam somente o manifesto da revisão
correspondente. Corrupção permanente pode colocar aquele asset em quarentena sem
bloquear outros assets nem modificar uma revisão mais recente.

A retenção de `source_download` e `inference_input` usa a carência configurada em
`TEMPORARY_RETENTION_HOURS` (24 horas por padrão). Exige conversão concluída,
classificação concluída ou desativada, preview atual confirmado no storage e nenhum
job ativo. Uma lease durável do asset impede iniciar processamento concorrente.
Falhas de exclusão deixam o recurso em `retiring`, para nova tentativa; thumbnails,
previews persistentes e originais Apple são preservados.

## Execução finita

`python -m photointel.services.task_runner` expõe os modos `discover`, `backfill`,
`worker`, `maintenance` e `migrate`. Limites de jobs e duração são obrigatoriamente
positivos e limitados. O modo backfill só consome trabalho previamente autorizado
no banco; não existe argumento CLI capaz de autorizar uma importação ilimitada.

SIGTERM interrompe novas aquisições e permite até oito segundos para confirmações
em andamento. Depois disso, cancela as tarefas locais e preserva leases/outbox para
recuperação. O processo sinalizado retorna um código de interrupção, em vez de
informar sucesso de execução ao Cloud Run.

## Evidência executada em 18/10/2026

Com PostgreSQL real, em banco de testes isolado, foram executados:

```bash
uv run pytest tests/integration/test_worker_transactions_v11.py \
  tests/integration/test_worker_ingestion.py tests/integration/test_api.py -q --tb=short
# 32 passed in 18.73s

uv run pytest tests/test_task_runner_v11.py tests/test_worker_policy.py -q
# 13 passed in 2.38s

uv run mypy apps/api/src/photointel/services/{worker,jobs,leases,media,inference}.py
# Success: no issues found in 5 source files

uv run pytest tests/integration/test_worker_transactions_v11.py -q --tb=short
# 8 passed in 13.68s (inclui a nova regressão de retenção)
```

Os oito testes novos de integração usam commits e conexões independentes, incluindo
roubo da posse durante upload/inferência, concorrência de aquisições, interrupção do
runner, outbox após crash, corrupção de cache com comprimento idêntico e retenção
interrompida com preview verificado. Os adapters
de storage desses testes usam arquivos privados locais; não constituem validação
R2, Modal, Cloud Run ou iCloud reais. A suíte de inferência usa o backend de teste
explicitamente configurado, e não representa inferência GPU real.
