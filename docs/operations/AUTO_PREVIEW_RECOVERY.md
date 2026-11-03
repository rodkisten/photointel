# Recuperação automática de thumbnails e previews

A execução é parte dos Cloud Run Jobs finitos `photointel-worker` e
`photointel-maintenance`. Não há cron dentro da API nem dependência de manter o
iPhone/PWA aberto.

## Fluxo

1. `photointel-discover` agenda descoberta incremental, que registra cada
   asset/manifesto e enfileira `media_download` independentemente. Backfill
   histórico ilimitado continua **proibido** sem autorização explícita.
2. `photointel-worker` executa download por foto; `metadata_extract` faz uma
   decodificação, persiste três previews e a entrada temporária de inferência.
   `thumbnail_generate` verifica/regenera, enquanto hash, qualidade e IA são
   independentes. A inferência GPU só roda se configurada.
3. Uma vez por `AUTO_PREVIEW_REPAIR_INTERVAL_MINUTES`, uma das invocações
   worker/maintenance disputa um lock PostgreSQL e reserva um ciclo.
4. O ciclo percorre **até** `AUTO_PREVIEW_REPAIR_BATCH_SIZE` assets com
   variantes ausentes/inválidas no catálogo, mantendo cursor entre execuções.
   Em outra passagem rotativa, confere por HEAD os objetos de **até**
   `AUTO_PREVIEW_VERIFY_BATCH_SIZE` imagens completas. Falhas de acesso ao
   provedor não são tratadas como objetos ausentes. Objetos realmente ausentes
   recebem status `invalid`, o que permite reconstrução.
5. Uma foto é enfileirada apenas se não tem job ativo/pausado e a versão da
   origem ainda é a mesma. Prefere recurso persistido privado no R2, senão
   somente baixa do iCloud com manifesto da revisão vigente e ingestão habilitada.
   Não remove originais e não escreve na Apple.
6. O limite de **uma tentativa automática por seis horas e até três por sete
   dias por asset/revisão** impede loop permanente. Erros definitivos permanecem
   visíveis e exigem recuperação manual ou correção do acesso iCloud. Jobs têm
   também suas próprias tentativas limitadas e backoff.
7. Um worker invocado após a descoberta ou maintenance acorda os jobs já
   enfileirados através do outbox; a fila, cursores, leases e resultados
   sobrevivem a interrupções e a redeploys.

## Configuração de ambiente (API + worker/maintenance)

```dotenv
AUTO_PREVIEW_REPAIR_ENABLED=true
AUTO_PREVIEW_REPAIR_INTERVAL_MINUTES=60
AUTO_PREVIEW_REPAIR_BATCH_SIZE=40
AUTO_PREVIEW_VERIFY_BATCH_SIZE=15
AUTO_PREVIEW_REPAIR_MAX_ATTEMPTS_WEEK=3
```

A frequência da auditoria interna é independente do Cloud Scheduler externo.
Os defaults de Scheduler são `discover: 0 * * * *`,
`worker: */10 * * * *` e `maintenance: 17 */6 * * *`, em UTC.
A invocação de um worker a cada 10 minutos **não** implica nova varredura
a cada 10 minutos: o horário de próximo ciclo fica persistido no banco.

Configurações aplicadas via `GCP_CONFIG_ENV` devem conter as chaves adicionais
no bloco de ambiente do Cloud Run (`extra_environment`), se diferentes dos
defaults acima. Faça o deploy tanto dos Jobs quanto da API. Para ativar os
agendamentos no arquivo de configuração GCP, use a linha
`AUTO_RESUME_SCHEDULES=json:true` no `GCP_CONFIG_ENV` (ou
`auto_resume_schedules=true` no JSON) e execute a fase Scheduler.
A criação é pausada por padrão para evitar importação/custos não autorizados;
**uma atualização de Scheduler preserva o estado existente**, sem pausar
agendamentos já ativos. A opção de retomada é explícita, não é alterada
implicitamente por deploys da API.

## Diagnóstico e limites

- `GET /v1/jobs/previews/audit`: pendências no catálogo.
- `GET /v1/jobs/previews/automation`: configuração, última varredura,
  contadores e próxima verificação. A tela de auditoria no Photos exibe o estado.
- `GET /v1/jobs/assets/{id}/preview`: status de uma mídia.
- `POST /v1/jobs/assets/{id}/preview/repair`: reparação explícita, inclusive
  quando o limite automático ou a fonte impedem novas tentativas.
- `/jobs`, Manage e Sentry: acompanhar jobs, erros e correlação.

A varredura HEAD detecta objetos inexistentes, não conteúdo corrompido com
status 200. A confirmação de integridade SHA-256 das fontes armazenadas ocorre
no pipeline de download/processamento. Um R2 fora do ar, iCloud com sessão
expirada ou fila/scheduler pausados impede progresso normal, mas não apaga o
catálogo. Vídeos continuam apenas catalogados na versão atual.
