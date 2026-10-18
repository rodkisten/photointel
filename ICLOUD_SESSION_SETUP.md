# Sessão iCloud em Cloud Run

A senha Apple nunca entra na API, no `.env`, no Secret Manager nem em argumentos
`--password`. O login inicial continua interativo, em Codespaces ou Cloud Shell,
com `icloudpd==1.32.3`. Apple pode exigir senha específica, 2FA, desbloqueio de
acesso web ou novo login. Estes comportamentos dependem de uma verificação real.

## Configuração

Cloud Run usa filesystem efêmero. Configure nos Jobs, por Secret Manager e
variáveis de implantação:

```dotenv
ICLOUD_ENABLED=false
ICLOUD_ACCOUNT=
ICLOUD_LIBRARY=
ICLOUD_SESSION_BACKEND=encrypted_object
ICLOUD_SESSION_KEY_ID=v1
ICLOUD_SESSION_MAX_BYTES=8388608
ICLOUD_SESSION_LEASE_SECONDS=180
ICLOUD_SESSION_MAX_AGE_HOURS=720
```

`ICLOUD_SESSION_KEY` contém exatamente 32 bytes aleatórios codificados em base64.
É um segredo distinto da senha Apple e da chave de backup. Crie o material num
arquivo privado, sem imprimi-lo, e importe esse arquivo no Secret Manager:

```bash
umask 077
mkdir -p "$HOME/.config/photointel"
python -c 'import base64,secrets; from pathlib import Path; p=Path.home()/".config/photointel/session-key"; p.write_bytes(base64.b64encode(secrets.token_bytes(32))); p.chmod(0o600)'
gcloud secrets versions add photointel-icloud-session-key \
  --data-file="$HOME/.config/photointel/session-key"
```

O comando presume um secret já criado na implantação autorizada; não cria
recursos nem concede IAM. Somente as identidades dos Jobs que acessam iCloud e o
operador do bootstrap precisam ler esse secret. Preserve uma cópia protegida da
chave para recuperação; perder todas as cópias exige reautenticar a sessão.

## Primeiro login pelo iPhone

1. Abra o repositório no Codespaces por Safari ou abra o Cloud Shell na Console.
2. Execute `uv sync --group ingest`. Configure conexão PostgreSQL, R2 privado,
   conta e biblioteca no ambiente privado do terminal. Não faça commit do `.env`.
3. Importe a chave sem mostrá-la no terminal. Este exemplo usa o arquivo local
   acima; não escreva o valor literal no histórico:

```bash
export ICLOUD_SESSION_KEY="$(cat "$HOME/.config/photointel/session-key")"
export ICLOUD_SESSION_BACKEND=encrypted_object
export ICLOUD_ENABLED=true
uv run python -m photointel.services.icloud_admin authenticate
uv run python -m photointel.services.icloud_admin libraries
uv run python -m photointel.services.icloud_admin verify
uv run python -m photointel.services.session_admin publish --confirm
uv run python -m photointel.services.session_admin status
```

A senha e o código 2FA são solicitados apenas pelo provedor de console do
icloudpd num TTY. `publish` exige uma prova local de verificação válida, recente e
vinculada à conta/biblioteca. Não é possível iniciar esse login pela API.
`status=available_unverified` significa que existe snapshot; não prova que Apple
aceita os cookies. `session_admin verify` reidrata e faz uma consulta real, podendo
falhar com autenticação expirada. Após publicar, remova somente a cópia de cookies
no terminal, quando os Jobs já estiverem configurados:

```bash
uv run python -m photointel.services.icloud_admin clear --confirm-clear-session
```

Esse comando não apaga fotos, não revoga a sessão nos servidores Apple e não
remove o snapshot remoto. Ele limpa exclusivamente o diretório local dedicado.

## O que acontece em cada execução

`session_directory(settings)` adquire um lease PostgreSQL exclusivo para o hash
da conta/biblioteca, incrementa seu fencing token e fecha a transação. Em seguida,
busca o objeto privado imutável apontado pelo banco, valida SHA-256, versão,
geração, contexto e AES-256-GCM, e extrai arquivos regulares em diretório efêmero
0700 com arquivos 0600. Tar traversal, symlinks, hardlinks, devices, arquivos
excessivos e expansão além do limite são rejeitados.

Apple e R2 são acessados sem uma transação ou row lock do banco aberta. Um
heartbeat renova o lease em transações curtas. Ao terminar normalmente, cookies
alterados são criptografados com nonce aleatório de 96 bits e AAD contendo conta/
biblioteca, geração, versão e key ID; um novo objeto imutável é salvo. O ponteiro
muda apenas com compare-and-swap de owner, token, geração e validade do lease.
Um dono antigo não pode sobrescrever a geração nova. Cookies inalterados não
criam outro snapshot. Uma falha mantém o último snapshot confirmado. O diretório
em claro é removido no encerramento do contexto; SIGKILL também perde todo o
filesystem efêmero da tarefa. Não há promessa de apagar bytes fisicamente da RAM.

Um crash depois do upload e antes do CAS pode deixar ciphertext órfão. Ele não é
usado pelo próximo Job; a referência PostgreSQL é a autoridade. Retenha snapshots
antigos criptografados conforme a política operacional, faça inventário e remova
somente objetos sem referência após uma janela maior que a duração máxima de
Jobs e backups. Não configure lifecycle para apagar o objeto atualmente apontado.

## Expiração, revogação e rotação

- Sessão ausente, corrupta ou antiga: Jobs falham de forma recuperável, sem
  solicitar senha e sem inventar login válido. Refaça login/verificação/publicação
  no terminal. A idade máxima do snapshot é um limite operacional, não um prazo
  oficial de validade de Apple.
- `session_admin revoke --confirm` invalida somente o ponteiro local do sistema e
  incrementa a geração. Não afirma revogar cookies na Apple. Para revogar na Apple,
  use os controles oficiais de segurança da conta.
- Não publique por cima de um lease em uso. Espere a execução terminar ou expirar;
  não edite tokens/leases manualmente.
- Para rotacionar a chave, pause ingestão e mantenha a chave antiga disponível.
  Com ela carregada, use um `ICLOUD_SESSION_DIRECTORY` vazio e execute
  `session_admin download --confirm`. Faça `icloud_admin verify` nessa cópia.
  Gere nova chave, crie nova versão do Secret Manager, incremente
  `ICLOUD_SESSION_KEY_ID`, carregue a chave nova no terminal e execute
  `session_admin publish --confirm`. Atualize os Jobs e execute uma verificação
  antes de retirar a chave antiga. `publish` autorizado não precisa descriptografar
  o snapshot anterior. Backups antigos continuam dependendo da chave antiga para
  restaurar cookies; podem ser descartados/reautenticados conforme sua política.

O usuário operador precisa autorizar qualquer criação de recurso cobrado. A
implementação e os testes locais não autenticam uma conta Apple nem validam as
credenciais reais do usuário. Nunca inclua cookies, backups ou fotos reais em
artifacts públicos de CI.
