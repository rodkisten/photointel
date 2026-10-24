# 🧭 GitHub Actions: catálogo e regras do Photo Intelligence

Auditoria de **13 workflows** em `.github/workflows/`, 24/10/2026. Nem todo workflow deve rodar a cada commit e **nenhum teste de PR deve herdar segredos de produção**.

## 🗂️ Inventário, necessidade e disparo

| Workflow | Quando executa | Por que permanece |
|---|---|---|
| [🧪 CI](../../.github/workflows/ci.yml) | Push/PR (exceto somente docs), manual | Testes essenciais de Python, web, integração e segurança, sem publicar imagens |
| [🧰 Bootstrap de dependências](../../.github/workflows/bootstrap-validation.yml) | **Manual** ou `validation/bootstrap` | Resolve locks/contratos e valida o projeto quando precisa recuperar dependências; deixou de duplicar CI a cada push |
| [🐳 Compose](../../.github/workflows/compose-validation.yml) | Manual ou `validation/compose` | Verifica `make setup`, `make dev` e persistência com banco/MinIO reais |
| [🏗️ Arquiteturas](../../.github/workflows/container-architectures.yml) | Manual ou `validation/container-architectures` | Testa AMD64/ARM64 e bibliotecas nativas sem enviar imagens |
| [🌐 Cloudflare Pages](../../.github/workflows/deploy-pages.yml) | Manual, `production` | Publica a PWA; independente do Cloud Run API |
| [🧱 Bootstrap GCP](../../.github/workflows/gcp-bootstrap.yml) | Manual `plan` / `apply`, `production` | Provisiona IAM, SAs, bucket, secrets e Artifact Registry via gcloud, com WIF administrativo separado |
| [🚀 Deploy GCP](../../.github/workflows/gcp-deploy.yml) | Manual, `main`, `production` | Build/reuso de imagem, Jobs, API, Scheduler e cleanup, com identidade Deployer limitada |
| [☁️ Validação GCP](../../.github/workflows/gcp-validation.yml) | Push/PR em infra GCP e action compartilhada, manual | Testes de CLI/bootstrap, config, Worker e política ZIP sem GCP real |
| [🧠 CPU real](../../.github/workflows/real-cpu-smoke.yml) | Manual confirmado ou `validation/real-cpu` | Testa JoyTag/SigLIP com pesos públicos, custo de minutos de runner/download |
| [🧾 Proveniência](../../.github/workflows/release-manifest.yml) | Manual | Manifesto de evidência do release, sem realizar deploy |
| [🖥️ SSH + Make](../../.github/workflows/ssh.yml) | Manual | Máquina efêmera para iPhone via Tailscale, Make e eventual commit automático |
| [📱 WebKit](../../.github/workflows/webkit-validation.yml) | Manual ou `validation/webkit` | Playwright WebKit Linux em viewport iPhone, sem alegar Safari físico |
| [📦 ZIP → Pull Request](../../.github/workflows/zip.yml) | Manual | Aplica patches ZIP validados criando branch/PR, com filtros para arquivos sensíveis |

**Conclusão:** todos atendem finalidades distintas. O maior desperdício era disparar a validação pesada de bootstrap junto da CI geral; agora fica opt-in. GCP Deploy/Bootstrap e Pages permanecem separados por identidades e provedores. Remover qualquer workflow restante desabilitaria uma capacidade documentada.

## 🔑 Escopo de Environment, vars e secrets

| Chave / origem | Consumidores | Onde configurar |
|---|---|---|
| `vars.GCP_CONFIG_ENV` (dotenv multiline com nomes de secrets, IDs, limites e origens **não secretas**) | `gcp-deploy` e `gcp-bootstrap` | GitHub **Environment `production`**, em Settings → Environments |
| `vars.GCP_BOOTSTRAP_WORKLOAD_IDENTITY_PROVIDER` / `vars.GCP_BOOTSTRAP_SERVICE_ACCOUNT` | `gcp-bootstrap` | Environment `production`; WIF e conta administrativos **separados** |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` / `GCP_DEPLOY_SERVICE_ACCOUNT` | `gcp-deploy` | **Dentro** de `GCP_CONFIG_ENV`, extraídos pela action reutilizável |
| `vars.VITE_API_BASE_URL` / `vars.PAGES_PROJECT` | `deploy-pages` | Environment `production` |
| `secrets.CLOUDFLARE_API_TOKEN` / `secrets.CLOUDFLARE_ACCOUNT_ID` | `deploy-pages` | **Environment secrets** de `production` |
| `secrets.TS_OAUTH_CLIENT_ID` / `secrets.TS_OAUTH_SECRET` | `ssh` | **Repository Actions secrets** existentes |
| `GITHUB_TOKEN` / `github.token` | `ci` / `zip` | Token efêmero fornecido pelo próprio GitHub, não é var configurável |

**CI, Compose, WebKit, CPU real e outros testes isolados usam variáveis sintéticas** do próprio workflow. Não faz sentido conectá-los a `vars.GCP_CONFIG_ENV` ou ao Environment `production`. Para qualquer valor sensível, use `secrets.*`, nunca `vars.*` ou texto em arquivo versionado.

## ♻️ Action reutilizável de configuração GCP

[`.github/actions/gcp-config/action.yml`](../../.github/actions/gcp-config/action.yml) substitui a configuração duplicada nos dois workflows GCP. O mesmo componente é invocado duas vezes:

1. **`mode: prepare`:** recebe `vars.GCP_CONFIG_ENV` do Environment `production`; instala `python-dotenv` fixado; valida o projeto, SHA, referências de Secret Manager e WIF; escreve `infra/gcp/config.local.json` com modo `0600` e `infra/gcp/rendered/`, disponibilizando os outputs `workload_identity_provider` e `service_account`.
2. **Execução:** autenticação curta `google-github-actions/auth` (sem JSON key permanente), `setup-gcloud` e comandos autorizados.
3. **`mode: cleanup`:** acionada com `if: always()` caso o checkout tenha concluído, remove `config.local.json` e `rendered/` mesmo se autenticação ou build falhar. Os arquivos efêmeros do `auth` são limpos pelo próprio post-step dessa action.

Padrão para novo workflow GCP:

```yaml
jobs:
  example:
    name: "☁️ [GCP] Example"
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: read
      id-token: write
    steps:
      - name: "📥 [SOURCE] Checkout"
        id: checkout
        uses: actions/checkout@v4
      - name: "🧩 [CONFIG] Prepare production configuration"
        id: config
        uses: ./.github/actions/gcp-config
        with:
          mode: prepare
          config-env: ${{ vars.GCP_CONFIG_ENV }}
          confirm-project: ${{ inputs.confirm_project }}
          release-sha: ${{ github.sha }}
      # Operações autorizadas; se for bootstrap, usar uma identidade WIF administrativa própria.
      - name: "🧹 [CLEANUP] Remove generated files"
        if: always() && steps.checkout.outcome == 'success'
        uses: ./.github/actions/gcp-config
        with:
          mode: cleanup
```

### ⛔ Não confundir os três tipos de armazenamento

Limpeza de `config.local.json` no runner **não apaga** imagens do Artifact Registry, tarballs do bucket GCS ou ZIPs/artifacts de Actions. Consulte [retenção de artifacts](../deployment/ARTIFACT_RETENTION.md). Na validação GCP, o upload do artifact de planos é **desativado por padrão** e pode ser habilitado manualmente com `upload_evidence=true`. Isso reduz falhas decorrentes do limite atual de armazenamento de artifacts do GitHub.

## 🎨 Labels e emojis

O padrão adotado em **todos os 13 workflows** é nome legível para workflow, job e cada step: `<emoji> [ÁREA] Ação`. Labels usuais: `[SOURCE]`, `[SETUP]`, `[CONFIG]`, `[AUTH]`, `[TEST]`, `[BUILD]`, `[DEPLOY]`, `[DATA]`, `[EVIDENCE]`, `[CLEANUP]` e `[PATCH]`.

Os títulos são cosméticos: **não faça testes dependerem do texto de um step**. Use IDs estáveis como `id: apply`. O teste do importador ZIP foi corrigido para não quebrar quando os labels forem editados.

## ✅ Checklist de manutenção

- Workflow necessário e gatilho descritos nesta página.
- Manual quando demanda custos, acessos privilegiados ou modelos pesados.
- Segredos em `secrets.`, configurações não secretas em `vars.`, Environment `production` somente para deploy.
- GCP usa a action compartilhada e limpeza garantida; autenticação administrativa separada do Deployer.
- Tudo rotulado com emoji, inclusive job, step e nome principal.
- Evidências de CI guardadas somente quando realmente úteis; consultar logs de execução antes de reenviar.
- Testar a validação GCP offline após qualquer mudança na action, YAML ou IAM. Não considerar deploy real validado até executá-lo.
