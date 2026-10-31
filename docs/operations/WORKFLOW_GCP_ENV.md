# Configuração única dos workflows via GCP_CONFIG_ENV

Em GitHub → Settings → Environments → production → Variables, mantenha **uma única variável `GCP_CONFIG_ENV`**. Ela pode conter um objeto JSON ou o dotenv legado. Apenas metadados não sensíveis e **referências** a Secret Manager pertencem a essa variável.

Adicione ao objeto existente de `infra/gcp/config.example.json` as seguintes propriedades (trecho ilustrativo, não é o JSON completo):

```json
{
  "GCP_WORKLOAD_IDENTITY_PROVIDER": "projects/799387180206/locations/global/workloadIdentityPools/SEU_POOL/providers/SEU_PROVIDER",
  "GCP_DEPLOY_SERVICE_ACCOUNT": "photointel-deployer@photointel.iam.gserviceaccount.com",
  "GCP_BOOTSTRAP_WORKLOAD_IDENTITY_PROVIDER": "projects/799387180206/locations/global/workloadIdentityPools/github-bootstrap/providers/photo-intelligence-bootstrap",
  "GCP_BOOTSTRAP_SERVICE_ACCOUNT": "photointel-bootstrap@photointel.iam.gserviceaccount.com",
  "workflows": {"worker": {"name": "SEU-WORKER-WEB", "domain": "photos.migos.club", "api_base_url": "https://api.photos.migos.club"}},
  "workflow_secrets": {
    "CLOUDFLARE_API_TOKEN": {"name": "photointel-pages-token", "version": "1"},
    "CLOUDFLARE_ACCOUNT_ID": {"name": "photointel-cloudflare-account", "version": "1"},
    "TS_OAUTH_CLIENT_ID": {"name": "photointel-tailscale-client", "version": "1"},
    "TS_OAUTH_SECRET": {"name": "photointel-tailscale-secret", "version": "1"}
  }
}
```

**No formato dotenv legado**, use `WORKFLOWS__WORKER__NAME`, `WORKFLOWS__WORKER__API_BASE_URL`, e `WORKFLOW_SECRETS__CLOUDFLARE_API_TOKEN__NAME`, `WORKFLOW_SECRETS__CLOUDFLARE_API_TOKEN__VERSION`, seguindo o mesmo padrão para os outros três secrets. Também adicione as chaves `GCP_BOOTSTRAP_*` no mesmo dotenv.

### Atenção: Worker da API não é o Worker do frontend

O repositório possui `infra/cloudflare/cloud-run-proxy/wrangler.toml`, que define **`photointel-api-relay`** para responder em `api.photos.migos.club` e encaminhar apenas chamadas `/v1` ao Cloud Run. Esse Worker não deve receber o bundle React do frontend.

Para publicar a interface, use um Worker separado que aceite Static Assets; declare explicitamente o nome **real** dele no `GCP_CONFIG_ENV`:

```dotenv
WORKFLOWS__WORKER__NAME=SEU_WORKER_FRONTEND_EXISTENTE
WORKFLOWS__WORKER__DOMAIN=photos.migos.club
WORKFLOWS__WORKER__API_BASE_URL=https://api.photos.migos.club
```

Troque `SEU_WORKER_FRONTEND_EXISTENTE` pelo nome do Worker de frontend. Ele não pode ser `photointel-api-relay`. `WORKFLOWS__WORKER__DOMAIN` deve corresponder a `FRONTEND_ORIGIN`, sem `https://`. A origem da API **não pode ser o mesmo hostname** em uma implantação de frontend Worker com assets estáticos; o Worker de API deve responder separadamente. O workflow `🌐 Worker · Web` publica via `wrangler deploy` com `assets.not_found_handling=single-page-application`, workers.dev e preview desativados, e configura o domínio customizado.

`WORKFLOWS__PAGES__PROJECT`, `WORKFLOWS__PAGES__API_BASE_URL` e `CLOUDFLARE_PAGES_PROJECT` são obsoletos. Entradas Pages legadas podem permanecer no dotenv durante a migração, mas o fluxo Worker não as utiliza.

A referência atual `photointel-pages-token` pode ser mantida apesar do nome; não é necessário criar outro secret se o token já estiver válido e tiver os escopos certos. O token Cloudflare requer escopo de edição de Workers, e permissões para configurar o domínio/rota; um token limitado somente ao Pages não é suficiente. Os valores continuam no Google Secret Manager, nunca em `GCP_CONFIG_ENV`. O mesmo GCP WIF autorizado é usado para ler o segredo temporariamente.

## Ativação inicial

1. Crie no Google Secret Manager os quatro secrets referenciados e adicione seus valores como versões. Não escreva os valores no JSON, em Issues, ou no repositório. O bootstrap cria contêineres ausentes, **não cria versões nem valores**.
2. Atualize a única variável de Environment `GCP_CONFIG_ENV` com os IDs, nomes e números de versão reais. Troque todas as origens e placeholders do exemplo por sua configuração real.
3. Execute **Setup GCP → apply** para provisionar containers ausentes e atribuir `roles/secretmanager.secretAccessor` no escopo desses quatro secrets ao `photointel-deployer`. Esse serviço é acessado via WIF, sem chave de service account.
4. Rode **Worker Web** ou **SSH**. Worker Web só exporta valores públicos para `GITHUB_ENV`; Cloudflare API Token e Account ID são buscados quando o Wrangler é executado. SSH interativo usa WIF na `main` para ler Tailscale OAuth no Secret Manager, mascara os valores e não os escreve em arquivos do repositório.

## Solução de problemas: Pages

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
