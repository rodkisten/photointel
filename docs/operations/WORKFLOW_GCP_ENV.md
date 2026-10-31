# Configuração única dos workflows via GCP_CONFIG_ENV

Em GitHub → Settings → Environments → production → Variables, mantenha **uma única variável `GCP_CONFIG_ENV`**. Ela pode conter um objeto JSON ou o dotenv legado. Apenas metadados não sensíveis e **referências** a Secret Manager pertencem a essa variável.

Adicione ao objeto existente de `infra/gcp/config.example.json` as seguintes propriedades (trecho ilustrativo, não é o JSON completo):

```json
{
  "GCP_WORKLOAD_IDENTITY_PROVIDER": "projects/799387180206/locations/global/workloadIdentityPools/SEU_POOL/providers/SEU_PROVIDER",
  "GCP_DEPLOY_SERVICE_ACCOUNT": "photointel-deployer@photointel.iam.gserviceaccount.com",
  "GCP_BOOTSTRAP_WORKLOAD_IDENTITY_PROVIDER": "projects/799387180206/locations/global/workloadIdentityPools/github-bootstrap/providers/photo-intelligence-bootstrap",
  "GCP_BOOTSTRAP_SERVICE_ACCOUNT": "photointel-bootstrap@photointel.iam.gserviceaccount.com",
  "workflows": {"worker": {"name": "photointel-api-relay", "domain": "photos.migos.club"}},
  "workflow_secrets": {
    "CLOUDFLARE_API_TOKEN": {"name": "photointel-pages-token", "version": "1"},
    "CLOUDFLARE_ACCOUNT_ID": {"name": "photointel-cloudflare-account", "version": "1"},
    "TS_OAUTH_CLIENT_ID": {"name": "photointel-tailscale-client", "version": "1"},
    "TS_OAUTH_SECRET": {"name": "photointel-tailscale-secret", "version": "1"}
  }
}
```

**No formato dotenv legado**, configure as duas chaves abaixo dentro de `GCP_CONFIG_ENV` (ou omita-as, pois são derivadas do repositório e de `FRONTEND_ORIGIN`):

```dotenv
WORKFLOWS__WORKER__NAME=photointel-api-relay
WORKFLOWS__WORKER__DOMAIN=photos.migos.club
```

### Um único Cloudflare Worker, frontend e API

O workflow **🌐 Worker · Web** reutiliza o Worker **`photointel-api-relay`** que já está definido no repositório. Ele publica o JavaScript do relay **junto** ao build do React. Não cria segundo Worker e não depende de Cloudflare Pages.

- `https://photos.migos.club/` e rotas da SPA servem React por `env.ASSETS.fetch()`.
- `https://photos.migos.club/v1/*` encaminha ao serviço Python `photointel-api` do Cloud Run, sem colocar outra URL no navegador.
- O domínio já configurado `api.photos.migos.club` permanece associado **ao mesmo Worker** para preservar clientes antigos. Somente as rotas `/v1/*` funcionam nesse hostname.
- O workflow consulta a URL **real** do serviço Cloud Run com `gcloud run services describe`; não usa o endereço `run.app` de exemplo nem armazena esse valor como outra GitHub Var.
- O frontend usa `VITE_API_BASE_URL=` (origem vazia), fazendo requests para `/v1/*` no mesmo domínio. `WORKFLOWS__WORKER__API_BASE_URL` e `WORKFLOWS__PAGES__*` legadas são ignoradas.

**Cloudflare Access:** o hostname `photos.migos.club` precisa estar protegido por uma aplicação Access cuja política e audience sejam aceitas pela API, porque o relay encaminha o JWT assinado de Access para o Cloud Run. Verifique `ACCESS_AUDIENCE` e o login de usuários, inclusive chamadas `/v1/*`; a alteração de domínio, por si só, não cria nem valida políticas Access. O hostname legado da API também precisa manter a política adequada.

**DNS e custom domain:** a publicação usa `custom_domain=true` para `photos.migos.club` e preserva `api.photos.migos.club`. A Cloudflare pode rejeitar a associação se já houver CNAME incompatível apontando para outro destino; ajuste esse registro no painel, sem apagar as regras do Access antes de conferir o novo funcionamento. O workflow permanece manual e não altera o DNS antecipadamente.

**Segredos:** mantenha o Google Secret Manager atual para `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID`; é necessária permissão de Workers Scripts e de custom domain. O script não publica os valores no GitHub. Troque tokens que tenham sido expostos em texto puro. O valor da referência `photointel-pages-token` não precisa ser renomeado se o conteúdo e os escopos forem válidos.

## Ativação inicial

1. Crie no Google Secret Manager os quatro secrets referenciados e adicione seus valores como versões. Não escreva os valores no JSON, em Issues, ou no repositório. O bootstrap cria contêineres ausentes, **não cria versões nem valores**.
2. Atualize a única variável de Environment `GCP_CONFIG_ENV` com os IDs, nomes e números de versão reais. Troque todas as origens e placeholders do exemplo por sua configuração real.
3. Execute **Setup GCP → apply** para provisionar containers ausentes e atribuir `roles/secretmanager.secretAccessor` no escopo desses quatro secrets ao `photointel-deployer`. Esse serviço é acessado via WIF, sem chave de service account.
4. Rode **Worker Web** ou **SSH**. Worker Web exporta apenas valores públicos para `GITHUB_ENV` e busca Cloudflare API Token e Account ID no Secret Manager. O deploy junta React e relay em um único Worker. SSH interativo usa WIF na `main` para ler Tailscale OAuth no Secret Manager, mascara os valores e não os escreve em arquivos do repositório.

## Solução de problemas: Worker único

A etapa **⚙ Env** verifica acesso efetivo ao `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` antes de instalar dependências e compilar o frontend. Se falhar, os logs indicam uma das causas, sem revelar tokens:

- **Secret ou versão inexistente:** `GCP_CONFIG_ENV` contém só a referência. O bootstrap cria o secret, mas **não cria uma versão contendo o token**. Adicione o valor atualizado com `gcloud secrets versions add` no Cloud Shell e confira a versão `WORKFLOW_SECRETS__...__VERSION`.
- **PERMISSION_DENIED:** execute **Setup GCP → apply** com a identidade administrativa para conceder `roles/secretmanager.secretAccessor` ao `photointel-deployer` nos secrets declarados. WIF não concede automaticamente acesso a versões.
- **Versão desativada ou destruída:** crie/ative uma versão válida e atualize a referência.

Para inspecionar apenas metadados, sem expor credenciais, no Cloud Shell:

```bash
gcloud secrets describe photointel-pages-token --project=photointel
gcloud secrets versions list photointel-pages-token --project=photointel
```

Não mantenha tokens em texto puro no próprio `GCP_CONFIG_ENV` nem os cole em comandos que fiquem no histórico do terminal.

## Exceções e fronteiras de segurança

- `NOTIFY_DEVICE_ID` e `NOTIFY_TOKEN` permanecem como GitHub Secrets porque os alertas precisam poder ocorrer **antes** da autenticação GCP. O `GITHUB_TOKEN` é emitido automaticamente pelo GitHub.
- CI e testes de Pull Request continuam sem o Environment de produção. Os comandos Make não interativos no workflow SSH usam o Environment `development` e não precisam de credenciais GCP.
- Os campos `workflow_secrets` são distintos de `secrets` de runtime. As credenciais de Cloudflare/Tailscale não são injetadas na API, nos Cloud Run Jobs nem no migrador Neon.
- **Nunca inclua senhas ou tokens em `GCP_CONFIG_ENV`**, mesmo que ele seja uma variável de Environment. Use somente referências fixas a versões de Secret Manager.
