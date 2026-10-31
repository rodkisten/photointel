# Cloudflare Worker: assets e logs importantes

O deploy publica o código Worker e os arquivos de `apps/web/dist` como Static
Assets via binding `ASSETS`. O editor mostrar somente `worker.js` não comprova
que os assets estejam ausentes: os arquivos estáticos não são módulos JavaScript
do Worker. O resumo do workflow informa a contagem de arquivos enviados.

O diagrama de conexões do painel não representa quantidade de processos/replicas;
a lista de Workers da conta fica em Workers & Pages. Um domínio ligado ao
Worker pode servir o frontend e encaminhar `/v1/*` para Cloud Run sem outro
Worker conectado por service binding. O `404` precisa ser investigado na resposta
e nos logs, não deduzido do número de arquivos exibidos no editor.

## Logs habilitados pelo deploy

A configuração gerada por `prepare_workflow_env.py worker-deploy` inclui
`observability.enabled=true`, `head_sampling_rate=1` e
`observability.logs.invocation_logs=false`. Apenas ativar a observabilidade no
wrangler.toml de referência não basta: o workflow publica uma configuração JSON
temporária própria.

Em **Cloudflare → Workers & Pages → photointel → Observability → Logs**, procure
pelo campo `event`:

| Evento | Significado |
|---|---|
| routing_config_invalid | FRONTEND_ORIGIN ou CLOUD_RUN_ORIGIN ausente/inválido |
| frontend_assets_binding_missing | ASSETS não está ligado à versão publicada |
| frontend_assets_failed | Falha de assets ou 404 na raiz |
| frontend_asset_missing | Asset em /assets/* devolveu 404 |
| frontend_assets_unreachable | Falha ao acessar os assets |
| upstream_redirect_rejected | Cloud Run redirecionou uma chamada de API |
| upstream_server_error | Backend devolveu 5xx |
| upstream_rate_limited | Backend devolveu 429 |
| upstream_slow | Resposta bem-sucedida da API demorou pelo menos 3 s |
| upstream_unreachable | Não foi possível obter resposta do backend |

Sucessos rotineiros e erros esperados de autenticação 401/403 não geram logs
customizados. Eventos repetidos da mesma categoria/rota agrupada/status são
limitados a um por minuto por isolate; `suppressed_since_last` informa quantos
foram omitidos desde o registro anterior. Não é um limite global entre isolates.
URLs completas, query strings, IDs de mídia, cabeçalhos, cookies, JWTs, corpos e
mensagens brutas de exceção não são registrados pelo código. A plataforma ainda
pode registrar falhas do runtime independentemente desses eventos customizados.

Um binding ASSETS ausente agora retorna 503 explícito, em vez de 404 genérico.
Isso ajuda a identificar uma publicação incompleta sem confundi-la com uma rota
inexistente. Um 404 visto no editor/preview, isoladamente, não confirma a resposta
real do domínio de produção.

Referências: https://developers.cloudflare.com/workers/static-assets/ e
https://developers.cloudflare.com/workers/observability/logs/workers-logs/.
