# Configuração única dos workflows via GCP_CONFIG_ENV

Em GitHub → Settings → Environments → production → Variables, mantenha **uma única variável `GCP_CONFIG_ENV`**. Ela pode conter um objeto JSON ou o dotenv legado. Apenas metadados não sensíveis e **referências** a Secret Manager pertencem a essa variável.

Adicione ao objeto existente de `infra/gcp/config.example.json` as seguintes propriedades (trecho ilustrativo, não é o JSON completo):

```json
{
  "GCP_WORKLOAD_IDENTITY_PROVIDER": "projects/799387180206/locations/global/workloadIdentityPools/SEU_POOL/providers/SEU_PROVIDER",
  "GCP_DEPLOY_SERVICE_ACCOUNT": "photointel-deployer@photointel.iam.gserviceaccount.com",
  "GCP_BOOTSTRAP_WORKLOAD_IDENTITY_PROVIDER": "projects/799387180206/locations/global/workloadIdentityPools/github-bootstrap/providers/photo-intelligence-bootstrap",
  "GCP_BOOTSTRAP_SERVICE_ACCOUNT": "photointel-bootstrap@photointel.iam.gserviceaccount.com",
  "workflows": {"worker": {"name": "photointel", "domain": "photos.migos.club"}},
  "workflow_secrets": {
    "CLOUDFLARE_API_TOKEN": {"name": "photointel-pages-token", "version": "1"},
    "CLOUDFLARE_ACCOUNT_ID": {"name": "photointel-cloudflare-account", "version": "1"},
    "TS_OAUTH_CLIENT_ID": {"name": "photointel-tailscale-client", "version": "1"},
    "TS_OAUTH_SECRET": {"name": "photointel-tailscale-secret", "version": "1"}
  }
}
```

**No formato dotenv legado**, use a configuração abaixo dentro de `GCP_CONFIG_ENV`. As duas chaves Worker são opcionais, porque o nome e domínio já podem ser deduzidos das configurações atuais:

```dotenv
WORKFLOWS__WORKER__NAME=photointel
WORKFLOWS__WORKER__DOMAIN=photos.migos.club
```

### Um Worker de produção para React e API

Os logs do GitHub Actions confirmam que o Worker **`photointel`** já foi publicado em `photos.migos.club`. O novo workflow atualiza **esse mesmo Worker**, sem criar outro recurso.

- `https://photos.migos.club/` e demais rotas da SPA servem React usando `env.ASSETS.fetch()`.
- `https://photos.migos.club/v1/*` encaminha a requisição ao `photointel-api` no Cloud Run por meio do relay no mesmo Worker.
- O build define `VITE_API_BASE_URL=` para que o frontend consulte `/v1/*` pela mesma origem. A antiga `WORKFLOWS__WORKER__API_BASE_URL` é ignorada.
- O workflow descobre a URL real do Cloud Run via `gcloud run services describe` usando WIF, em vez de usar `run.app` de exemplo.
- O Worker antigo `photointel-api-relay` **não é alterado nem excluído** pela migração. O domínio `api.photos.migos.club` continua vinculado a ele para clientes antigos até confirmar que a API funciona em `photos.migos.club/v1/*`.

**Segurança:** o hostname `photos.migos.club` precisa estar protegido por Cloudflare Access, e a audiência do JWT deve corresponder ao valor `ACCESS_AUDIENCE` validado no Cloud Run. A proteção Access do hostname antigo deve continuar enquanto ele for usado. O workflow não modifica essas políticas.

**DNS:** o Worker de frontend já está associado ao domínio, portanto não é necessário criar outro hostname. O deploy mantém a associação atual e publica o frontend + gateway como uma única versão do Worker `photointel`. Caso o Cloudflare aponte conflito de CNAME/Custom Domain, verifique o DNS no painel, sem remover o serviço anterior de imediato.

**Secrets:** continuam somente referências a `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` no `GCP_CONFIG_ENV`; os valores vêm do Google Secret Manager. Se o token atual possui permissão Workers Scripts, o secret `photointel-pages-token` pode continuar com esse nome legado. Rotacione tokens expostos.

**Para finalizar a consolidação:** após testar acesso, navegação da SPA, 401/403, mídia privada e `/v1/*`, será possível desativar o Worker legado `photointel-api-relay` e retirar sua rota antiga. **Não faça isso antes dos testes**, porque outras integrações podem usar `api.photos.migos.club`.

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
