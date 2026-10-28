# Configuração única dos workflows via GCP_CONFIG_ENV

Em GitHub → Settings → Environments → production → Variables, mantenha **uma única variável `GCP_CONFIG_ENV`**. Ela pode conter um objeto JSON ou o dotenv legado. Apenas metadados não sensíveis e **referências** a Secret Manager pertencem a essa variável.

Adicione ao objeto existente de `infra/gcp/config.example.json` as seguintes propriedades (trecho ilustrativo, não é o JSON completo):

```json
{
  "GCP_WORKLOAD_IDENTITY_PROVIDER": "projects/799387180206/locations/global/workloadIdentityPools/SEU_POOL/providers/SEU_PROVIDER",
  "GCP_DEPLOY_SERVICE_ACCOUNT": "photointel-deployer@photointel.iam.gserviceaccount.com",
  "GCP_BOOTSTRAP_WORKLOAD_IDENTITY_PROVIDER": "projects/799387180206/locations/global/workloadIdentityPools/github-bootstrap/providers/photo-intelligence-bootstrap",
  "GCP_BOOTSTRAP_SERVICE_ACCOUNT": "photointel-bootstrap@photointel.iam.gserviceaccount.com",
  "workflows": {"pages": {"project": "SEU-PAGES-PROJECT", "api_base_url": "https://api.seudominio.com"}},
  "workflow_secrets": {
    "CLOUDFLARE_API_TOKEN": {"name": "photointel-pages-token", "version": "1"},
    "CLOUDFLARE_ACCOUNT_ID": {"name": "photointel-cloudflare-account", "version": "1"},
    "TS_OAUTH_CLIENT_ID": {"name": "photointel-tailscale-client", "version": "1"},
    "TS_OAUTH_SECRET": {"name": "photointel-tailscale-secret", "version": "1"}
  }
}
```

**No formato dotenv legado**, use `WORKFLOWS__PAGES__PROJECT`, `WORKFLOWS__PAGES__API_BASE_URL`, e `WORKFLOW_SECRETS__CLOUDFLARE_API_TOKEN__NAME`, `WORKFLOW_SECRETS__CLOUDFLARE_API_TOKEN__VERSION`, seguindo o mesmo padrão para os outros três secrets. Também adicione as chaves `GCP_BOOTSTRAP_*` no mesmo dotenv.

## Ativação inicial

1. Crie no Google Secret Manager os quatro secrets referenciados e adicione seus valores como versões. Não escreva os valores no JSON, em Issues, ou no repositório. O bootstrap cria contêineres ausentes, **não cria versões nem valores**.
2. Atualize a única variável de Environment `GCP_CONFIG_ENV` com os IDs, nomes e números de versão reais. Troque todas as origens e placeholders do exemplo por sua configuração real.
3. Execute **Setup GCP → apply** para provisionar containers ausentes e atribuir `roles/secretmanager.secretAccessor` no escopo desses quatro secrets ao `photointel-deployer`. Esse serviço é acessado via WIF, sem chave de service account.
4. Rode **Pages** ou **SSH**. Pages só exporta valores públicos para `GITHUB_ENV`; Cloudflare API Token e Account ID são buscados quando o Wrangler é executado. SSH interativo usa WIF na `main` para ler Tailscale OAuth no Secret Manager, mascara os valores e não os escreve em arquivos do repositório.

## Exceções e fronteiras de segurança

- `NOTIFY_DEVICE_ID` e `NOTIFY_TOKEN` permanecem como GitHub Secrets porque os alertas precisam poder ocorrer **antes** da autenticação GCP. O `GITHUB_TOKEN` é emitido automaticamente pelo GitHub.
- CI e testes de Pull Request continuam sem o Environment de produção. Os comandos Make não interativos no workflow SSH usam o Environment `development` e não precisam de credenciais GCP.
- Os campos `workflow_secrets` são distintos de `secrets` de runtime. As credenciais de Cloudflare/Tailscale não são injetadas na API, nos Cloud Run Jobs nem no migrador Neon.
- **Nunca inclua senhas ou tokens em `GCP_CONFIG_ENV`**, mesmo que ele seja uma variável de Environment. Use somente referências fixas a versões de Secret Manager.
