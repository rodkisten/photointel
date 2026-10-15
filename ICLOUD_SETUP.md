# Configurar iCloud com segurança

O downloader usa `icloudpd` numa execução finita, agendada pelo serviço de
ingestão a cada 60 minutos. Ele lê o iCloud e baixa uma representação permitida;
não recebe opções de exclusão de mídia remota ou local. `ICLOUD_ENABLED=false`
é o padrão. A biblioteca e credenciais são do usuário, sem coleta pelo frontend.

## Pré-requisitos da conta

Confira no iPhone se a Proteção Avançada de Dados está desativada para este
fluxo, se o acesso aos dados do iCloud na web está permitido e se o login/2FA
funciona. Isso não garante compatibilidade: Apple pode mudar APIs, exigir nova
aprovação ou limitar contas. Não desative proteções de uma conta sem compreender
a decisão. Falhas devem resultar em estado explícito de autenticação/acesso.

Instale o projeto e prepare diretórios privados:

```bash
make setup
chmod 600 .env
chmod 700 var/icloud-session var/icloud-downloads
```

## Primeiro login pelo iPhone

Use um cliente SSH com chave e verifique a identidade do host. No terminal SSH
interativo do servidor, autentique o `icloudpd` com sua conta:

```bash
uv run --group ingest icloudpd --help
uv run --group ingest icloudpd --username seu-email-apple --cookie-directory var/icloud-session --auth-only
```

Digite a senha e o código 2FA somente no prompt interativo da ferramenta. Não
coloque a senha em argumento `--password`, `.env`, variável de ambiente,
workflow, script, histórico shell ou formulário da PWA. Não copie cookies ou
códigos para logs/screenshots. Se a versão instalada mudar opções de autenticação,
consulte seu `--help` e mantenha o login interativo.

Compose roda com UID 10001. Para login no volume correto do ambiente local:

```bash
bash infra/scripts/compose.sh run --rm ingestion icloudpd --username seu-email-apple --cookie-directory /data/icloud-session --auth-only
```

O comando substitui o serviço por uma sessão interativa; não coloque a senha no
comando. Em produção use o mesmo comando com
`PHOTOINTEL_COMPOSE_MODE=prod`; diretórios devem pertencer a UID 10001 e ter 0700.

## Ativar uma importação pequena

Edite `.env` no terminal e configure `ICLOUD_ACCOUNT`, `ICLOUD_LIBRARY`,
`ICLOUD_ENABLED=true`. Mantenha inicialmente:

```dotenv
DOWNLOAD_REPRESENTATION=medium
ALLOW_ORIGINAL_FALLBACK=false
INGESTION_IMPORT_LIMIT=100
MAX_DOWNLOAD_BYTES=20971520
MAX_RUN_DOWNLOAD_BYTES=2097152000
INGESTION_INTERVAL_MINUTES=60
GPU_ENABLED=false
```

Recrie API/worker/ingestion depois de alterar configuração. Confirme com
`make doctor` e status de ingestão; acompanhe contagem, bytes, erros e tempo.
O limite de download é por arquivo e por execução; uma representação ausente
fica indisponível. Original exige consentimento/configuração explícita e
continua sujeito aos limites. Não interprete erro de rede ou expiração da sessão
como prova de foto removida da biblioteca.

## Sessão expirada e recuperação

Pare agendamento antes de refazer login, autentique no diretório correto e só
retome após diagnóstico. Não descarte sessões em uso nem envie cookies por email.
Cookies são segredos: se precisar copiá-los ao trocar host, use canal seguro e
permissões privadas. Preferencialmente faça novo login no host de destino.

`icloudpd` não fornece garantia de keywords editáveis pelo iCloud. O catálogo
cloud permanece independente da ponte PhotoKit. Leia
[PYTO_BRIDGE.md](PYTO_BRIDGE.md) para o fluxo opcional no iPhone.
