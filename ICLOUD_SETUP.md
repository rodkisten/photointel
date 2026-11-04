# Configurar iCloud com segurança

> **Nota de revisão arquitetural (04/11/2026):** A descoberta usa **manifestos persistidos, cursor com âncoras e jobs por asset**. Login e 2FA reais, disponibilidade Apple, orçamento de bytes e capacidade Neon continuam sendo pré-requisitos, mesmo quando o fluxo local passa nos testes. Veja [implementação e fluxogramas](docs/architecture/INGESTION_AND_RECOVERY.md).

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
uv run --group ingest python -m photointel.services.icloud_admin authenticate
uv run --group ingest python -m photointel.services.icloud_admin verify
uv run --group ingest python -m photointel.services.icloud_admin libraries
uv run --group ingest python -m photointel.services.icloud_admin test
```

Digite a senha e o código 2FA somente no prompt interativo da ferramenta. Não
coloque a senha em argumento `--password`, `.env`, variável de ambiente,
workflow, script, histórico shell ou formulário da PWA. Não copie cookies ou
códigos para logs/screenshots. Se a versão instalada mudar opções de autenticação,
consulte seu `--help` e mantenha o login interativo.

Compose roda com UID 10001. Para login no volume correto do ambiente local:

```bash
bash infra/scripts/compose.sh run --rm ingestion python -m photointel.services.icloud_admin authenticate
bash infra/scripts/compose.sh run --rm ingestion python -m photointel.services.icloud_admin verify
```

O comando substitui o serviço por uma sessão interativa; não coloque a senha no
comando. Em produção use o mesmo comando com
`PHOTOINTEL_COMPOSE_MODE=prod`; diretórios devem pertencer a UID 10001 e ter 0700.
Configure `ICLOUD_ACCOUNT` no ambiente do servidor antes de autenticar. O wrapper
fixa os providers `console` de senha e MFA, exige TTY e verifica o acesso online.
Não confunde presença de cookies com sessão funcional. `test` lê somente uma
entrada e confere a disponibilidade da representação solicitada, sem download.

## Ativar uma importação pequena

Edite `.env` no ambiente local ou `.env.runtime` em produção e configure
`ICLOUD_ACCOUNT`, `ICLOUD_LIBRARY`,
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

Na PWA, use **iCloud → Sincronizar** com limite 100. Alternativa HTTP local:

```bash
curl --fail --request POST http://localhost:8000/v1/ingestion/start \
  --header 'Content-Type: application/json' \
  --data '{"limit":100}'
```

Em produção faça a operação pela PWA autenticada; não copie tokens Access para
scripts versionados. O retorno é um job persistido, não a importação concluída.
Verifique primeiro fotos/derivados e erros. Para ampliar os próximos runs, ajuste
o limite nas configurações e confirme explicitamente um lote acima de 100 na
interface. Essa alteração deve ser uma ação separada da instalação e do primeiro
teste; mantenha limites de bytes e GPU independentes.

## Sessão expirada e recuperação

Pare agendamento antes de refazer login, autentique no diretório correto e só
retome após diagnóstico. Não descarte sessões em uso nem envie cookies por email.
Cookies são segredos: se precisar copiá-los ao trocar host, use canal seguro e
permissões privadas. Preferencialmente faça novo login no host de destino.

```bash
uv run --group ingest python -m photointel.services.icloud_admin status
uv run --group ingest python -m photointel.services.icloud_admin reauthenticate
# Só limpa a sessão local dedicada; não apaga fotos nem revoga sessões na Apple.
uv run --group ingest python -m photointel.services.icloud_admin clear --confirm-clear-session
```

No Compose, substitua o prefixo `uv run --group ingest` por
`bash infra/scripts/compose.sh run --rm ingestion`. Para revogação remota após
comprometimento, use os controles da conta Apple. A integração é fixada em
`icloudpd==1.32.3`; outra versão exige revisar o adapter e as opções disponíveis.

`icloudpd` não fornece garantia de keywords editáveis pelo iCloud. O catálogo
cloud permanece independente da ponte PhotoKit. Leia
[PYTO_BRIDGE.md](PYTO_BRIDGE.md) para o fluxo opcional no iPhone.
