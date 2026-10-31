# Setup iCloud pelo terminal

O setup autentica, escolhe a biblioteca e publica uma sessão criptografada no R2.
Não inicia importações, GPU, Scheduler nem altera fotos na Apple.

## Preparação automática

Actions → **iCloud Setup** → `prepare` verifica a chave de sessão já referenciada
no worker, a conexão PostgreSQL e o bucket privado. Usa as configurações existentes
e um Job temporário com a mesma identidade do worker; o Job é removido ao terminar.
Não captura senha ou código Apple. O workflow não substitui o terminal interativo.

## Login no terminal do repositório

Abra o checkout atualizado no Codespaces ou na VM. No primeiro uso, autentique
o gcloud com sua conta administradora quando o comando solicitar: a identidade mínima da VM não tem acesso
aos secrets do banco/R2 e não recebe permissões adicionais por causa deste fluxo.

```bash
git pull --ff-only
python3 infra/scripts/icloud_terminal.py setup --account oirodolfo@icloud.com
```

Em Linux x86_64/ARM64, o comando instala gcloud no cache do usuário se necessário,
usando o arquivo oficial fixado na versão 591.0.0, com checksum SHA256 verificado
e extração segura. Não exige sudo nem altera arquivos de inicialização do shell.
Se faltar login Google ou estiver ativa a identidade mínima da VM, ele abre o
fluxo `gcloud auth login --no-launch-browser` no próprio terminal.

O comando instala as dependências travadas pelo `uv.lock`, lê as referências do
Job `photointel-worker` e resolve somente DATABASE_URL, STORAGE_ACCESS_KEY,
STORAGE_SECRET_KEY, ICLOUD_SESSION_KEY e BRIDGE_TOKEN_PEPPER. O pepper é necessário
para validar as configurações de produção; não é usado para autenticar na Apple.
Esses valores passam apenas na memória do processo e do subprocesso operacional,
nunca em argumentos, arquivos `.env`, relatórios ou logs. Use uma conta Google
que já tenha acesso aos recursos; o script não muda IAM.

Digite senha e 2FA somente nos prompts Apple. A senha não é enviada à API PhotoIntel
nem ao GitHub. Se houver mais de uma biblioteca, escolha pelo número. O fluxo:

1. Autentica em um diretório temporário privado.
2. Lista bibliotecas sem exigir uma seleção prévia.
3. Valida a biblioteca e o acesso a um item, sem baixar fotos.
4. Publica o snapshot via AES-GCM com a chave existente, lease e fencing.
5. Reabre a sessão criptografada e verifica o acesso online.
6. Salva apenas conta/biblioteca na tabela de configurações; mantém ingestão e GPU
   inalteradas. As cópias temporárias de cookies são removidas ao finalizar.

O backend e os workers precisam estar no release que reconhece os seletores
persistentes do setup. A configuração no banco sobrevive a novos deploys; não é
necessário copiar nomes de biblioteca para variáveis GitHub. A chave criptográfica
e todos os demais secrets continuam no Secret Manager.

## Depois do login

```bash
python3 infra/scripts/icloud_terminal.py verify
python3 infra/scripts/icloud_terminal.py test
python3 infra/scripts/icloud_terminal.py status
```

`verify` revalida online. `test` consulta um item e a representação solicitada sem
baixá-lo. `status` informa a evidência local da sessão restaurada, sem renovar a
prova online. Se a Apple exigir novo login, repita `setup` para reautenticar.

A presença de cookies não comprova acesso Apple válido. Um snapshot não pode ser
publicado depois de login ou teste falho. Não envie senha, 2FA ou cookies no chat.

Após sucesso, habilitar a ingestão e executar uma amostra inicial é uma etapa
separada. Ela permanece sujeita aos gates existentes, limites por execução e perfil
de catálogo; esse comando não atesta gates nem amplia o limite da biblioteca.

## Testes

```bash
python3 -m unittest discover -s infra/gcp/tests -p test_icloud_setup.py -v
```

Os testes usam provedores controlados e não comprovam login Apple real. A validação
real acontece no terminal, depois da autenticação e do 2FA do operador.
