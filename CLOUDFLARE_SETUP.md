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

## Access para o Bridge Pyto

A credencial Bearer do dispositivo autentica o protocolo Bridge na API; ela não
substitui o login exigido na borda Access. Para execução não interativa, crie uma
aplicação Access mais específica cobrindo apenas `api.seudominio.com/v1/bridge/*`
e uma política **Service Auth** com service token dedicado ao dispositivo. Não
inclua `/v1/apple-sync/*`, catálogo ou administração nessa política. Preserve as
políticas humanas nas demais rotas; não use uma regra Bypass global.

No Pyto configure o par de service token com o comando `access` descrito em
[PYTO_BRIDGE.md](PYTO_BRIDGE.md). Ambos os valores ficam no Keychain, separados
do Bearer do dispositivo. O cliente envia `CF-Access-Client-Id` e
`CF-Access-Client-Secret` também na matrícula. A API continua exigindo código de
matrícula de uso único e, depois, o Bearer do dispositivo para cada operação.
Não copie o token administrativo Cloudflare para o iPhone ou para a PWA.

Se usar a configuração local `infra/cloudflare/tunnel.example.yml`, adicione a
audience da aplicação Bridge ao `originRequest.access.audTag`, junto da audience
da API. São aplicações Access distintas; manter só a audience humana faz o
`cloudflared` rejeitar o Service Auth antes de chegar à API. A validação da
identidade humana na API continua restrita a `ACCESS_AUDIENCE`; as rotas Bridge
exigem suas credenciais próprias. No túnel gerenciado, confira a configuração
equivalente de validação Access no origin e teste as duas aplicações.

Teste com credencial de serviço ausente/revogada e com Bearer inválido antes de
inventariar fotos reais. Rotacione/revogue as duas credenciais separadamente.
Essa configuração depende da conta Access e permanece não verificada até um
teste real contra sua borda; testes unitários não comprovam a política remota.

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

## Produção v1.1: Cloud Run com origem alcançável

O destino principal é Cloud Run + Neon; o Tunnel acima continua opção VPS.
A URL `run.app` é alcançável pela rede pública. Não a descrevemos como origem
privada e não dependemos de DNS oculto. O serviço usa autorização da aplicação:
cada rota privada humana verifica assinatura RS256, issuer, audience, expiração
e allowlist de email. A borda e a API aplicam proteção em conjunto.
Um header email ou `X-Forwarded-*` não concede identidade. O container não deve
confiar em proxy headers de qualquer cliente (`--forwarded-allow-ips '*'`).
O destino Cloud Run usa `--no-proxy-headers`, sem inferir HTTPS de entrada externa.
Os health checks públicos retornam apenas estado mínimo, sem metadata pessoal.

Use o relay implementado em `infra/cloudflare/cloud-run-proxy/worker.mjs`, com
upstream fixo HTTPS `run.app`, nunca URL escolhida pelo cliente. Ele transmite
somente headers necessários, incluindo JWT Access assinado e Bearer Bridge;
recusa redirects da origem e impede cache CDN. O backend faz a validação
criptográfica mesmo que alguém contorne o Worker e chame `run.app` diretamente.
Não combine esta implantação com Cloud Run IAM obrigatório sem implementar
outra identidade de origem compatível: um JWT Access não é um ID token Google.

```bash
cp infra/cloudflare/cloud-run-proxy/wrangler.example.toml \
   infra/cloudflare/cloud-run-proxy/wrangler.toml
# No arquivo local: informar a URL run.app real, hostname API e origem Pages.
node --test infra/cloudflare/cloud-run-proxy/worker.test.mjs
cd infra/cloudflare/cloud-run-proxy
npx wrangler deploy --config wrangler.toml
```

Esse deploy cria/atualiza recurso na conta Cloudflare e requer login e
aprovação do operador. O exemplo contém somente campos a preencher. Proteja
`api.SEUDOMINIO` com Access **antes** de usar dados reais. Não basta criar CNAME
para `run.app`: Host/TLS e o domínio precisam do relay ou de domain mapping
Google validado. `workers_dev=false` e `preview_urls=false` evitam hostnames
alternativos do relay. O projeto Pages também precisa de proteção dos previews
no Access; restrinja/desative `pages.dev` quando não puder protegê-lo.

No backend, acrescente a aplicação de serviço separada:

```dotenv
ACCESS_BRIDGE_AUDIENCE=AUDIENCE_DA_APLICACAO_BRIDGE
ACCESS_BRIDGE_SERVICE_TOKENS=["CLIENT_ID_DO_SERVICE_TOKEN.access"]
```

`ACCESS_BRIDGE_SERVICE_TOKENS` contém **Client IDs públicos**, nunca Client
Secrets. O JWT Service Auth traz `common_name` com esse ID e `sub` vazio; ele
não traz a identidade humana necessária para a API do catálogo. O backend
valida issuer/assinatura/audience/expiração e a allowlist exata também na
matrícula Bridge. Ausência de configuração bloqueia o Bridge em produção com
503; credencial inválida/faltando falha com 401/403. Enrollment ainda exige
código de uso único; rotas posteriores exigem Bearer próprio do dispositivo.
Apenas enviar `CF-Access-Client-Id` e `CF-Access-Client-Secret` diretamente para
`run.app` não funciona: esses headers são apresentados à borda Cloudflare, que
emite o JWT assinado encaminhado. O backend não confia nesses headers crus.

A API não consulta o painel Access a cada requisição. Revogar um Service Token
impede novos JWT na borda; um JWT já emitido pode durar até `exp`. Para bloqueio
imediato, remova seu Client ID da allowlist e revogue também o dispositivo
Bridge. Rotacione segredos separadamente. Não prometa revogação instantânea de
JWT offline já emitido sem esse procedimento.

Referências oficiais consultadas em 18/10/2026:

- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/
- https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/

Execute [aceitação física](docs/operations/iphone-acceptance.md) com Safari e
PWA reais, cookies expirados, login, rede móvel e mídia sem autorização. Os
testes locais verificam o código de autenticação e relay; não comprovam a
política criada na conta Cloudflare nem o comportamento de cookies no iPhone.
