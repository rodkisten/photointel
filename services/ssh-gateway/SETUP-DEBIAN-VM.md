# 🖥️ Registro de implantação: VM Debian · PhotoIntel SSH Gateway

> **Data:** 18/11/2026, horário local da VM (UTC−03:00).
> **Estado:** gateway HTTP e autenticação SSH local validados; integração SFTP pela API, WebSocket, Tunnel e Manage **ainda pendentes**.
> **Origem:** passos executados manualmente pelo operador, com saídas verificadas por capturas de tela da sessão SSH. Este documento não comprova testes que ainda não foram realizados.

## 📍 Ambiente confirmado

| Item | Valor |
| --- | --- |
| VM | `194.61.238.98` |
| Host observado no prompt | `vps-2480.coolify.hostzera.com.br` |
| Distribuição | Debian |
| Usuário humano SSH | `rod` |
| Porta SSH | `22` |
| Conta dedicada ao gateway | `photointel-ssh` |
| Diretório do repositório | `~/photointel` |
| Diretório do gateway | `~/photointel/services/ssh-gateway` |
| Diretório instalado | `/opt/photointel-ssh` |
| Arquivo de ambiente | `/etc/photointel-ssh.env` (não versionar o conteúdo) |
| Unidade systemd | `photointel-ssh.service` |
| Endpoint local | `http://127.0.0.1:8789/health` |
| SSH interno do gateway | `rod@127.0.0.1:22` |

## 1. Clonar e instalar

Conectado por SSH à VM como `rod`, o operador executou o instalador do repositório:

```bash
ssh -p 22 rod@194.61.238.98
git clone https://github.com/rodkisten/photointel.git ~/photointel
cd ~/photointel/services/ssh-gateway
sudo bash install-debian.sh
```

**Resultado observado:** dependências instaladas com sucesso, incluindo `aiohttp` e `asyncssh`. O instalador criou `/etc/photointel-ssh.env`, gerou uma chave pública Ed25519 dedicada e preparou a unidade systemd.

O script é reexecutável e não deve substituir o segredo já existente. **Não copie a chave privada nem o conteúdo do arquivo de ambiente para documentação ou logs públicos.**

## 2. Autorizar a chave do gateway para o usuário rod

A chave pública exibida pelo instalador foi acrescentada a `~rod/.ssh/authorized_keys` sem duplicá-la:

```bash
sudo -v
install -d -m 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"

PUBKEY="$(sudo cat /opt/photointel-ssh/id_ed25519.pub)"
grep -qxF "$PUBKEY" "$HOME/.ssh/authorized_keys" || \
  printf '%s\n' "$PUBKEY" >> "$HOME/.ssh/authorized_keys"
```

**Atenção:** este bloco presume que a sessão atual pertence a `rod`. Se estiver em um shell `root`, use explicitamente o diretório `/home/rod/.ssh` e ajuste proprietário e permissões, pois `$HOME` seria `/root`.

## 3. Fixar o host SSH local e configurar o catálogo

A fingerprint da chave pública do servidor SSH foi obtida com:

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

A configuração foi gravada em `/etc/photointel-ssh.env` como JSON no valor de `MANAGE_TERMINAL_VMS`, usando:

- `id`: `debian`
- `label`: `Debian VM`
- `host`: `127.0.0.1`
- `port`: `22`
- `username`: `rod`
- `hostKeySha256`: fingerprint SHA256 verificada da chave Ed25519 do servidor

**Não publicar o segredo compartilhado do gateway.** A fingerprint pública pode ser verificada novamente no servidor antes de distribuir a configuração ao Manage.

Para reconstruir somente a variável de catálogo, preservando as demais:

```bash
sudo python3 - <<'PY'
import json, pathlib, subprocess

p = pathlib.Path('/etc/photointel-ssh.env')
fingerprint = subprocess.check_output(
    ['ssh-keygen', '-lf', '/etc/ssh/ssh_host_ed25519_key.pub', '-E', 'sha256'],
    text=True,
).split()[1]
target = [{
    'id': 'debian',
    'label': 'Debian VM',
    'host': '127.0.0.1',
    'port': 22,
    'username': 'rod',
    'hostKeySha256': fingerprint,
}]
lines = p.read_text().splitlines()
lines = [
    'MANAGE_TERMINAL_VMS=' + json.dumps(target, separators=(',', ':'))
    if line.startswith('MANAGE_TERMINAL_VMS=') else line
    for line in lines
]
p.write_text('\n'.join(lines) + '\n')
print('SSH host fingerprint:', fingerprint)
PY
```

## 4. Iniciar e verificar o systemd

```bash
sudo systemctl enable --now photointel-ssh
sudo systemctl --no-pager --full status photointel-ssh
curl --fail http://127.0.0.1:8789/health
```

**Observação às 01:29:** `systemctl status` inicialmente exibiu `active (running)`, mas o primeiro `curl` recebeu `Connection refused`. Não houve evidência de falha permanente: o teste aconteceu imediatamente após a inicialização.

## 5. Diagnóstico posterior: HTTP 200 confirmado

```bash
sudo systemctl is-active photointel-ssh
sudo systemctl show photointel-ssh -p NRestarts -p ExecMainStatus
sudo ss -lntp | grep ':8789' || true
curl -v --max-time 5 http://127.0.0.1:8789/health
sudo journalctl -u photointel-ssh -n 35 --no-pager -o cat
```

**Saída confirmada às 01:30:**

```text
active
NRestarts=0
ExecMainStatus=0
LISTEN ... 127.0.0.1:8789 ... python
HTTP/1.1 200 OK
{"ok":true,"targets":1}
```

O processo está ativo, sem reinicializações naquele momento, e responde exclusivamente no loopback local. `/health` **não comprova** que o SSH ou SFTP interno funciona.

## 6. Validar a autenticação SSH dedicada

Executado na própria VM:

```bash
sudo -u photointel-ssh \
  ssh -i /opt/photointel-ssh/id_ed25519 \
  -o StrictHostKeyChecking=accept-new \
  -o BatchMode=yes \
  -o ConnectTimeout=5 \
  rod@127.0.0.1 \
  'whoami && pwd'
```

**Saída confirmada às 01:31:**

```text
Warning: Permanently added '127.0.0.1' (ED25519) to the list of known hosts.
rod
/home/rod
```

Isso comprova que a chave privada dedicada, acessível à conta `photointel-ssh`, autentica no `sshd` local como `rod`, sem solicitar senha. O `accept-new` usado nesse teste da CLI não substitui a validação de fingerprint exigida pelo código do gateway.

## 7. Estado atual e próximos testes

- [x] Instalação do gateway e dependências
- [x] Criação do usuário de serviço e par de chaves dedicado
- [x] Configuração do alvo SSH `debian` no arquivo de ambiente
- [x] Serviço systemd ativo
- [x] Porta `127.0.0.1:8789` escutando
- [x] `GET /health` retornando HTTP 200 com `targets=1`
- [x] Autenticação SSH local como `rod` via chave dedicada
- [x] Validar **API `POST /files`** com SFTP para listar e ler (22 entradas, SHA-256 correto, 18/11/2026 01:34)
- [ ] Validar escrita SFTP e conflito de versão
- [ ] Validar **WebSocket `GET /ws`** com ticket assinado, formato de protocolo e PTY
- [ ] Corrigir quaisquer incompatibilidades entre assinatura/claims do ticket emitido pelo Worker e o gateway
- [ ] Configurar Cloudflare Tunnel com política de acesso entre serviços, sem abrir `8789` na internet
- [ ] Configurar `MANAGE_TERMINAL_GATEWAY_URL`, `MANAGE_TERMINAL_GATEWAY_SECRET` e `MANAGE_TERMINAL_VMS` no Manage Worker
- [ ] Atualizar lockfile de Dexie e CodeMirror language-data; executar build e testes
- [ ] Validar editor React, recuperação IndexedDB, SSH, WebSocket e SFTP ponta a ponta

## 🔐 Regras de manutenção

1. Nunca compartilhar `/etc/photointel-ssh.env`, a chave privada ou tokens de Cloudflare em prints, logs ou commits.
2. Nunca publicar `8789` no IP público; manter bind em `127.0.0.1`.
3. Não desabilitar a verificação da chave pública do servidor SSH.
4. Não reiniciar ou alterar o `sshd` durante a implantação do gateway.
5. Testar SFTP e WebSocket separadamente antes de afirmar que o mini VS Code está operacional.
6. Atualizações do código no GitHub **não** atualizam automaticamente `/opt/photointel-ssh/server.py`; copiar a nova versão e reiniciar o serviço apenas após validação.

## 8. Próximo bloco: smoke test SFTP real (pendente de execução)

Um teste de integração **somente leitura** foi adicionado em `test-local.py`. Ele verifica `GET /health`, autentica `POST /files` com o segredo lido localmente, lista `/home/rod` via SFTP e lê `/etc/hostname` conferindo o SHA-256 retornado. Não grava arquivos, não expõe o segredo e não depende de Cloudflare.

Na VM:

```bash
cd ~/photointel
git pull --ff-only
cd services/ssh-gateway
sudo python3 test-local.py
```

Se o teste falhar, coletar somente os logs sem segredos:

```bash
sudo journalctl -u photointel-ssh -n 60 --no-pager -o cat
```

**Não marcar SFTP como validado até ver o resultado do teste.** O teste também não valida WebSocket PTY, escrita, conflitos ou integração com Manage.

## 9. Resultado real do teste de leitura (18/11/2026, 01:34)

O operador executou `sudo python3 test-local.py` na VM após `git pull --ff-only` e enviou a captura do terminal. Saída observada:

```text
✅ Gateway HTTP health: OK
✅ SFTP directory listing: 22 entries
✅ SFTP file read and SHA-256 version: OK
🎉 Read-only gateway smoke tests passed
```

**Próximo teste:** `test-write.py` foi adicionado ao repositório, mas **ainda não foi executado na VM**. Cria um arquivo aleatório `.photointel-sftp-smoke-*.txt` em `/home/rod`, grava via API SFTP, testa conflito 409 e apaga o arquivo no final. Rodar:

```bash
cd ~/photointel && git pull --ff-only
cd services/ssh-gateway
sudo python3 test-write.py
```

O script não altera arquivos de projetos existentes. Se falhar, coletar o erro e `sudo journalctl -u photointel-ssh -n 40 --no-pager -o cat`, ocultando segredos.
