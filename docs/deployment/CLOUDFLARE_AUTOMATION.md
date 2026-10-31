# Configuração Cloudflare com Wrangler + API oficial

Use **Actions → ☁️ Cloudflare Setup → plan/apply**. A entrada é a mesma variável
`GCP_CONFIG_ENV` do Environment `production`; não há uma segunda configuração
nem valores de credenciais para copiar entre painéis. `plan` consulta a conta e
mostra o inventário pretendido sem mutações. `apply` configura e publica.

## O que é gerenciado

| Recurso | Operação |
|---|---|
| Access `photointel` | Localizar/criar aplicação self_hosted, reutilizando ID e AUD quando existir |
| Domínio principal | Proteger o hostname inteiro de FRONTEND_ORIGIN, incluindo SPA, mídia e /v1/* |
| API legada | Descobrir api.<hostname> já associado a photointel-api-relay e manter proteção humana |
| Política humana | Allow apenas para ACCESS_ALLOWED_EMAILS; nenhum Bypass; substituir vínculos de políticas do app gerenciado |
| Login | Reutilizar One-time PIN ou criá-lo; preservar IdPs explicitamente selecionados no app |
| Bridge existente | Se ACCESS_BRIDGE_SERVICE_TOKENS estiver configurado, aplicação mais específica só para /v1/bridge/*, com Service Auth e os tokens existentes |
| R2 | Verificar/criar STORAGE_BUCKET; desabilitar acesso público r2.dev; não apagar objetos |
| API e Jobs GCP | Sincronizar AUD real e issuer, usando update-env-vars; preservar imagens e secret references |
| Worker photointel | Wrangler publica script + assets, domínio, binding ASSETS e logs importantes |
| Verificação | Visitas sem sessão a /, /library e /v1/info devem ser redirecionadas ao Access |

O login `/auth/login` usa ACCESS_TEAM_DOMAIN e AUD atuais no Worker. Access
continua protegendo o hostname; a API continua validando assinatura, issuer,
audience, expiração e allowlist. O fluxo não usa e-mail de cabeçalhos como
prova de identidade.

O repositório mantém o domínio/nome, allowlist e referências de secrets como
entrada desejada. Os IDs e audiences gerados são consultados da API Cloudflare.
O `GCP_CONFIG_ENV` não precisa ser editado manualmente para copiar um AUD novo:
a implantação do Worker e as fases deploy/jobs-deploy do release GCP resolvem o
AUD atual da aplicação gerenciada antes da publicação. A atualização runtime do
setup não muda código, imagens, banco, R2 keys, limites nem agenda de ingestão.

## Credenciais e permissões

Reutiliza `workflow_secrets.CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID`, com
versões numéricas no Secret Manager, via WIF do deployer já existente. O token
Cloudflare precisa das permissões necessárias na conta/zona corretas:

- Access Apps and Policies Edit;
- Access Organizations/Identity Providers/Groups Edit (ler organização e criar OTP);
- Workers Scripts Edit e permissões de custom domains/Workers Routes;
- Zone Read e DNS Edit quando exigidos para criar o domínio;
- Workers R2 Storage Edit para bucket e configuração de acesso público.

A identidade Google usa as permissões existentes de leitura dos dois secrets e
Cloud Run Admin para atualizar os parâmetros da API/Jobs. Não usa service-account
key, token em VITE_*, token no repositório ou Global API Key. Um token sem
permissões não é promovido pelo script: o operador precisa autorizar os escopos
uma única vez e atualizar sua versão no Secret Manager se o valor do token mudar.
Erros 401/403 nunca são interpretados como recurso ausente.

## Preservação e conflitos

O setup não apaga Workers, DNS, aplicações de terceiros, bancos, imagens,
service tokens ou objetos R2. O Worker legado continua onde já estava. Não cria
Tunnel para a arquitetura Cloud Run; os arquivos Oracle/VPS são alternativas.
Não cria nem rotaciona credenciais de dispositivos Bridge ou credenciais S3;
utiliza as existentes quando essa integração está configurada. Sem Client IDs
Bridge configurados, os paths continuam sob Access humano e o resumo mostra o
Service Auth desativado, em vez de inventar uma credencial perdida no deploy.

Um app Bridge existente no path exato `/v1/bridge/*` pode ser adotado mesmo com
nome antigo, mantendo ID e AUD. As regras devem conter apenas seletores explícitos
de Service Auth, sem Bypass nem condições que seriam perdidas. Os Client IDs são
resolvidos dos tokens existentes; referências a tokens já removidos são preservadas
com aviso, sem criar credenciais. Isso não restaura um dispositivo cujo token foi
removido. A allowlist humana configurada continua sendo aplicada ao Bridge.

Uma aplicação PhotoIntel existente só pode ser adotada se todos os seus
hostnames/paths pertencerem ao escopo esperado. Ambiguidade, apps específicas
que se sobreponham ou domínio R2 público customizado inesperado interrompem o
fluxo antes de substituir recursos sem inventário. Ao reconciliar o app
PhotoIntel, as políticas anexadas passam a corresponder à allowlist configurada;
políticas Bypass antigas não permanecem vinculadas ao app gerenciado.

Alterações de aplicação/política usam os mesmos IDs nas reexecuções. O setup é
retomável, não uma transação entre provedores: uma falha posterior não desfaz
operações já concluídas. Não há rollback destrutivo automático.

## Uso por CLI

Com gcloud autenticado e a configuração local preparada pela action existente:

```bash
CONFIRM_PROJECT=photointel python3 infra/scripts/cloudflare_setup.py plan
CONFIRM_PROJECT=photointel python3 infra/scripts/cloudflare_setup.py apply
CONFIRM_PROJECT=photointel python3 infra/scripts/cloudflare_setup.py sync
CONFIRM_PROJECT=photointel python3 infra/scripts/cloudflare_setup.py verify
```

O `apply` Python configura a conta e sincroniza o runtime GCP. O workflow completo
continua com build do frontend e Wrangler para publicar o Worker. Não há build
Docker. O modo `sync` apenas consulta audiences e atualiza config.local.json.
A verificação sem sessão não equivale a um login real no Safari: após o sucesso,
a autenticação humana ainda precisa ser concluída pelo usuário no iPhone.

## Testes e fontes

```bash
python3 -m unittest discover -s infra/gcp/tests -p test_cloudflare_setup.py -v
```

APIs oficiais: https://developers.cloudflare.com/api/resources/zero_trust/ e
https://developers.cloudflare.com/api/resources/r2/.
Wrangler/Static Assets: https://developers.cloudflare.com/workers/static-assets/.
