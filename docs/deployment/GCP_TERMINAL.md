# Terminal persistente no iPhone

> **Nota de revisão arquitetural (04/11/2026):** Terminal e Cloud Shell não são requisito de execução diária: publicação e diagnóstico têm workflows e Manage. Não exponha secrets, cookies Apple ou tokens em logs de terminal, issue ou captura. Veja [arquitetura e evidências](../architecture/INFRASTRUCTURE_AND_DEPLOY.md).

## Build separado das operações

O dropdown agora inclui `build`. `provision`, `start`, `stop` e `status` **não
executam Docker build**. `provision` resolve a tag `terminal:ready` para um digest
imutável; se ainda não existir, reutiliza a imagem mais recente já publicada no
pacote `terminal`, inclusive imagens antigas com tag de SHA do repositório.
Assim, uma tentativa que falhou no firewall pode reutilizar a imagem já enviada.
Se não houver nenhuma imagem, a mensagem pede `action=build` uma vez.

`build` usa uma tag `cli-SHA256_DO_DOCKERFILE`, independente do SHA dos demais
arquivos do projeto. Se essa tag existir, apenas reutiliza e atualiza `ready`;
rebuild ocorre quando o Dockerfile muda. Para atualizar a base Linux/gcloud com
a mesma lista de ferramentas, altere o Dockerfile (por exemplo, sua versão base)
e rode `build`. A VM mantém o digest resolvido até um novo `provision`.

Após esta atualização, rode **Setup GCP → apply** para conceder à conta bootstrap
`roles/compute.instanceAdmin.v1`, `roles/compute.securityAdmin` e
`roles/iam.roleAdmin`, depois **GCP Terminal → provision**. A conta runtime
recebe um binding de Service Account User para bootstrap poder anexá-la à VM;
nenhum desses papéis administrativos é concedido ao deployer ou ao runtime.
Erros de acesso ao firewall agora mostram a classificação e a permissão sem
imprimir conteúdo bruto que possa conter credenciais.

A VM `photointel-terminal` executa um container Linux com gcloud, jq, gawk,
OpenSSH cliente/servidor, Git, tmux, rsync, ripgrep, fzf, Python, psql, SQLite,
curl, wget, editores e ferramentas de rede. O login Tailscale SSH do usuário
`rod` abre diretamente o Bash do container. Nenhum servidor SSH do container é
publicado. O OpenSSH instalado serve para conexões de saída e usos opcionais.

## Configuração e primeiro uso

Usa exclusivamente a variável existente `GCP_CONFIG_ENV` do Environment
`production`, a action compartilhada de configuração, o Artifact Registry e as
referências existentes `workflow_secrets.TS_OAUTH_CLIENT_ID` e `TS_OAUTH_SECRET`.
Não é necessário adicionar secrets ao GitHub nem copiar credenciais para imagens.
O objeto `terminal` é opcional; com a configuração atual em `us-central1`, os
defaults já bastam. A rede/sub-rede `default` precisa existir nessa região.

No formato dotenv, acrescente apenas se quiser personalizar:

```dotenv
TERMINAL__NAME=photointel-terminal
TERMINAL__ZONE=us-central1-a
TERMINAL__MAX_MINUTES=json:120
TERMINAL__DISK_GB=json:30
TERMINAL__TAG=tag:ci
TERMINAL__NETWORK=default
TERMINAL__SUBNET=default
```

No formato JSON, as mesmas opções ficam sob `"terminal"`, com `max_minutes` e
`disk_gb` como números. Não coloque chaves de API ou senhas nesse objeto.
Só são aceitas regiões elegíveis ao Free Tier: us-central1/us-east1/us-west1;
a zona acompanha a região existente. Tamanho da máquina é fixo em e2-micro.

1. Após integrar esta mudança à `main`, abra Actions → **📱 GCP Terminal**.
2. Execute `plan` para verificar a configuração sem acessar o Google Cloud.
3. Execute `provision`: reutiliza a imagem publicada e cria/atualiza a VM. Se não
   existir imagem, execute `build` uma vez para compilar, testar e publicar. Essa operação usa a identidade
   bootstrap administrativa já configurada, sem elevar a identidade de deploy.
4. No Tailscale, confirme que o OAuth client existente tem escopo `auth_keys`
   com permissão para `tag:ci` (ou a tag configurada). A conta precisa permitir
   dispositivos pré-autorizados; Tailnet Lock requer seu processo de assinatura.
5. Adicione à política Tailscale uma regra de rede e uma regra SSH para **seu
   e-mail específico**, tag e usuário. Exemplo para mesclar, preservando as regras
   existentes e substituindo o e-mail:

```json
{
  "grants": [
    {"src": ["SEU_EMAIL"], "dst": ["tag:ci"], "ip": ["tcp:22"]}
  ],
  "ssh": [
    {"action": "accept", "src": ["SEU_EMAIL"], "dst": ["tag:ci"], "users": ["rod"]}
  ]
}
```

A tag padrão reutiliza o OAuth client do workflow SSH existente. Para isolar
melhor o terminal de runners CI, autorize `tag:terminal` nesse client e configure
`TERMINAL__TAG=tag:terminal`, usando essa tag nas duas regras acima. A política do
Tailscale não é alterada automaticamente pelo workflow.

6. No iPhone, conecte o app Tailscale à mesma rede. No seu cliente SSH, conecte
   a `rod@photointel-terminal`, porta 22, com MagicDNS ativo. Também pode usar o
   IP Tailscale mostrado na lista de máquinas. O primeiro boot demora mais por
   instalar Docker/Tailscale e baixar a imagem. `RUNNING` indica VM ligada,
   não confirma prontidão do container. Se o cliente pedir reautenticação web,
   conclua pelo fluxo Tailscale; clientes compatíveis com Tailscale SSH dispensam
   chave SSH cadastrada manualmente.

Depois use `start`, `stop` e `status` no mesmo workflow. Não há runner GitHub
ocupado esperando sua sessão terminar. O workflow termina após controlar a VM.
`provision` novamente interrompe a sessão atual para atualizar imagem/configuração, sem rebuild.
`start` em VM já ligada não estende o prazo. Fechar o app SSH não desliga a VM.

## Desligamento, persistência e custos

O limite padrão de 120 minutos é aplicado pelo próprio Compute Engine
(`maxRunDuration`, ação STOP), mesmo se o script de instalação falhar. Há também
um timer systemd local. Cada partida de uma VM parada ganha novo prazo; um reboot
não renova o limite do provedor. O desligamento pode levar alguns segundos além
do prazo. Pode interromper sessões e comandos: salve arquivos antes.

O IPv4 **efêmero** existe somente enquanto a VM está ligada e pode mudar a cada
partida. O endereço Tailscale é persistido no host, permitindo usar o mesmo nome.
Não há Cloud NAT, balanceador, Cloud Scheduler ou Cloud Build neste recurso.
O firewall bloqueia todo ingresso público; Tailscale usa conexões de saída e
pode recorrer a DERP, com menor desempenho. Não depende de abrir UDP público.

O Free Tier é compartilhado pela conta: não garante uma segunda VM/disco grátis.
O disco pd-standard de 30 GB conta para a franquia, inclusive o sistema e imagens
Docker. IPv4, tráfego, Artifact Registry, Secret Manager e minutos GitHub Actions
podem gerar cobrança conforme uso/franquias; Tailscale Personal tem plano gratuito.
Duas horas/dia equivalem a cerca de US$ 0,30/mês **apenas de IPv4**, à tarifa
US$ 0,005/h. Parar preserva o disco e não remove eventuais cobranças de armazenamento.

`/home/rod` é persistido em `/var/lib/terminal/home` no disco da VM, incluindo
repositórios e configurações gcloud. Instalações via sudo dentro do container
persistem entre stop/start enquanto o container não for recriado; provisionar
novamente recria o container. Adicione ferramentas definitivas ao Dockerfile.
Não há clone automático do repositório privado nem token GitHub persistido.
Sem socket Docker/volume raiz do host no container; o usuário SSH do host pertence
ao grupo docker e, portanto, deve ser tratado como administrador dessa VM.
SFTP pelo wrapper não é suportado; use rsync via SSH ou git para arquivos.

## Identidades e permissões

A identidade bootstrap precisa conseguir habilitar APIs, administrar instâncias,
firewall e roles IAM customizadas, criar service accounts, usá-las, alterar suas
políticas e as dos dois secrets/Artifact Registry, além de publicar imagens.
O Setup GCP reconcilia os três papéis adicionais de Compute/custom roles
utilizando a permissão Project IAM Admin que a identidade bootstrap já possuía.
As permissões administrativas iniciais (incluindo Project IAM Admin e gestão de
WIF) continuam sendo configuradas por um administrador conforme o bootstrap
existente. Nenhum papel Owner/Editor é atribuído ao terminal ou ao deployer.

O provisionamento cria:

- service account runtime dedicada, com Artifact Registry Reader no repositório
  existente e Secret Accessor somente nos dois secrets OAuth existentes;
- custom role `photointelTerminalOperator` com get/start/stop;
- binding dessa role no recurso da VM para a identidade deployer existente;
- firewall de ingresso negado, VM e seu disco.

A VM pode ler as versões dos dois secrets por necessidade do enrollment Tailscale;
qualquer administrador desse terminal tem acesso equivalente. Não recebe acesso
a secrets do banco/R2, Cloud Run ou outros serviços. Para administrar PhotoIntel
pelo gcloud, autentique sua própria conta uma vez:

```bash
gcloud auth login --no-launch-browser
gcloud config set project photointel
```

As credenciais pessoais ficam na home persistente. `gcloud auth revoke` remove o
login quando terminar. Um container Linux não é uma VM completa: systemd e
serviços do host não são administrados por esse shell.

## Automação externa / Atalhos

O fluxo foi desenhado para acionamento programático com o workflow_dispatch do
GitHub, sem expor uma URL pública que liga a VM. Um Atalho pode chamar o endpoint
abaixo com token GitHub de acesso restrito a este repositório, permissão
Actions: write, guardado no seu dispositivo:

```http
POST https://api.github.com/repos/rodkisten/photointel/actions/workflows/gcp-terminal.yml/dispatches
Authorization: Bearer TOKEN_DO_DISPOSITIVO
Accept: application/vnd.github+json
Content-Type: application/json

{"ref":"main","inputs":{"action":"start"}}
```

Troque `start` por `stop` para desligar. HTTP 204 confirma o disparo, não a
prontidão da VM; acompanhe a execução no GitHub. O token nunca entra na VM ou
em GCP_CONFIG_ENV. Este PR não cria um Atalho iOS nem registra tokens no aparelho.

## Validação e diagnóstico

```bash
python3 -m unittest discover -s infra/terminal -p 'test_*.py' -v
bash -n infra/terminal/startup.sh
```

`Terminal validation` compila a imagem e verifica os comandos sem credenciais de
produção em PRs. O workflow operacional só aceita `main`/Environment production.
Se enrollment ou pull falhar, use o console GCP/log da inicialização para
investigar; não publique logs contendo tokens. Reexecute `provision` após corrigir
IAM/referências/tag. O workflow não exclui disco nem dados.

Referências: [Free Tier](https://docs.cloud.google.com/free/docs/free-cloud-features),
[limite nativo de execução](https://docs.cloud.google.com/compute/docs/instances/limit-vm-runtime),
[IP e cobrança](https://cloud.google.com/vpc/network-pricing),
[Tailscale Personal](https://tailscale.com/docs/account/manage-plans/free-plans-discounts),
[OAuth](https://tailscale.com/docs/features/oauth-clients),
[Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh).

