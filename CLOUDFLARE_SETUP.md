# Cloudflare: Pages, Tunnel, Access e R2

São quatro configurações independentes. O aplicativo não cria infraestrutura
numa conta sem credenciais/autorizações reais. A implantação manual do frontend
está em `.github/workflows/deploy-pages.yml`; o workflow usa environment
`production` e segredos apenas em `workflow_dispatch`.

## R2 privado

Crie um bucket dedicado sem acesso público e sem domínio público conectado.
Emita uma credencial S3 restrita a esse bucket e às operações necessárias.
Configure no host em `.env.runtime` 0600 para produção (`.env` no ambiente local):

```dotenv
STORAGE_BACKEND=r2
STORAGE_ENDPOINT=https://SEU_ACCOUNT_ID.r2.cloudflarestorage.com
STORAGE_BUCKET=photointel-private
STORAGE_REGION=auto
STORAGE_ACCESS_KEY=CHAVE_RESTRITA_AO_BUCKET
STORAGE_SECRET_KEY=SEGREDO_DO_BUCKET
```

Os valores acima são campos a preencher na conta real. Nunca os coloque no
bundle, variáveis `VITE_*`, git ou issue. Derivados ficam privados; distribuição
ocorre após autorização com URL curta ou proxy da aplicação. Verifique em um
cliente sem login que uma URL de objeto não assinado não abre. Habilite retenção
ou backup de objetos conforme disponibilidade da conta; `pg_dump` não inclui R2.

## Tunnel e origem privada

Crie um Cloudflare Tunnel para o host Oracle, registre seu token no servidor e
configure um public hostname como `api.seudominio.com` apontando a
`http://gateway:8080` na rede Docker. HTTPS termina na borda Cloudflare; a origem
HTTP é exclusivamente a rede privada de containers. Configure firewall Oracle
e do host sem portas públicas 5432/8000/8080/9000/9001.

Use `CLOUDFLARE_TUNNEL_TOKEN` em `.env` de controle com Compose production.
Credenciais PostgreSQL de bootstrap/migração também ficam nesse arquivo; ele
não é injetado na API/worker. Os segredos Access/R2/Modal ficam no arquivo
separado `.env.runtime`. A alternativa por arquivo
está em `infra/cloudflare/tunnel.example.yml`; não misture token gerenciado e
arquivo de credenciais. O hostname de exemplo deve ser substituído no painel
ou arquivo. Proteja o arquivo/token com 0600 e nunca mostre `docker inspect`
ou o ambiente completo em relatórios.

## Access e validação na API

Crie uma aplicação Access para o hostname da API, com política **Allow** apenas
para o email escolhido. Não crie regra Bypass para `/v1`, mídia, bridge ou docs.
Copie audience tag e domínio do team, depois configure em `.env.runtime`:

```dotenv
APP_ENV=production
AUTH_MODE=cloudflare
FRONTEND_ORIGIN=https://fotos.seudominio.com
API_ORIGIN=https://api.seudominio.com
ACCESS_TEAM_DOMAIN=SEU_TEAM.cloudflareaccess.com
ACCESS_AUDIENCE=AUDIENCE_DA_APLICACAO_API
ACCESS_ALLOWED_EMAILS=["seu-email@exemplo.com"]
CORS_ORIGINS=["https://fotos.seudominio.com"]
```

A API valida assinatura, issuer, audience, expiração e allowlist; a política
na borda é uma proteção adicional. Não substitua isso por leitura de cabeçalho
email ou validação apenas do conteúdo decodificado do JWT. Produção também
exige `BRIDGE_TOKEN_PEPPER` longo e armazenamento privado.

Frontend e API em hostnames distintos requerem sessão Access no hostname da API
e credentials CORS explícitos; confira o comportamento no Safari do iPhone.
No Access da API configure CORS para a origem HTTPS exata, credentials e os
métodos usados; trate o preflight `OPTIONS` pelas configurações CORS específicas
do Access, mantendo GET/POST/PATCH/DELETE autenticados. Evite wildcard de origem
com credenciais. Primeiro abra o hostname da API no Safari para completar seu
login Access, depois retorne à PWA. Use domínio customizado do mesmo site para
frontend/API; bloqueios de cookies de terceiros podem impedir `pages.dev`
acessando API de outro domínio mesmo com CORS correto.
Evite políticas diferentes para subdomínios que deixem o login em loop.
Uma alternativa operacional é servir a PWA e `/v1` pela mesma origem gateway;
isso reduz negociação cross-origin e continua exigindo Access/API validados.

## Pages/PWA

Crie um projeto Pages com saída `apps/web/dist`; proteja o hostname público e
domínio customizado com Access. Confirme que nenhum hostname alternativo
`pages.dev` permite acesso anônimo ao frontend. A proteção deve cobrir preview
deployments quando usados com dados da conta.

```bash
npm --prefix apps/web ci
VITE_API_BASE_URL=https://api.seudominio.com npm --prefix apps/web run build
cp infra/cloudflare/pages-headers apps/web/dist/_headers
npx wrangler pages deploy apps/web/dist --project-name SEU_PROJETO
```

Os passos precisam de login/credencial Cloudflare real. O workflow manual usa
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, e vars `PAGES_PROJECT` e
`VITE_API_BASE_URL`. Token deve limitar-se ao projeto/conta necessários.
Não ative `pull_request_target` para executar código de PR com segredos.

Após publicar, teste login autorizado, email não permitido, ausência de token,
JWT com audience errada, thumbnail privado e logout. Adicione a PWA à tela de
início somente após confirmar esses controles. Cache offline deve conter apenas
o shell estático: fotos, respostas privadas e URLs assinadas não são dados para
cache público.
