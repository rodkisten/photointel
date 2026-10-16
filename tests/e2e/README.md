# Testes de ponta a ponta

Os cenários executáveis ficam em `apps/web/tests/e2e/application.spec.ts`.
Essa localização permite resolver `@playwright/test` a partir do único lockfile
JavaScript, em `apps/web/package-lock.json`, sem links de `node_modules`.

Execute `make test-e2e` após migrar e popular PostgreSQL e armazenamento privado
com imagens sintéticas. Os testes exigem API e worker ativos com `APP_ENV=test`,
`INFERENCE_BACKEND=test`, `GPU_ENABLED=true` e os pins de modelo de teste.
A API principal usa autenticação local somente neste ambiente de teste.

Também inicie uma segunda API em `127.0.0.1:8001`, com `AUTH_MODE=cloudflare`,
`ACCESS_TEAM_DOMAIN=ci.cloudflareaccess.com`, `ACCESS_AUDIENCE=ci` e
`ACCESS_ALLOWED_EMAILS='["ci@example.invalid"]'`. Não são necessárias credenciais
Cloudflare: a ausência de JWT deve ser rejeitada antes de buscar chaves públicas.
`AUTH_REJECTION_API_URL` pode alterar essa URL. Os workflows versionados iniciam
ambas as APIs e o worker e encerram os processos ao terminar.

O Playwright inicia Vite em `127.0.0.1:4173`, encaminhando `/v1` à API na porta
8000. Configure `FRONTEND_ORIGIN=http://127.0.0.1:4173` no backend.
`API_PROXY_TARGET` e `PLAYWRIGHT_BASE_URL` permitem alterar essas URLs.

Os cenários usam o banco, a fila e os objetos privados reais de desenvolvimento.
Somente o adapter de inferência explicitamente restrito a testes produz vetores
determinísticos. Eles não validam modelos JoyTag/SigLIP reais, credenciais iCloud,
Cloudflare hospedado, Modal ou hardware PhotoKit.

Há cenários de navegação, biblioteca, detalhe, filtros, busca semântica de teste,
tags manuais, álbuns, duplicatas, ingestão, conclusão de jobs, Bridge somente
leitura, rejeição de autenticação, mídia privada e viewport de 375 px.
