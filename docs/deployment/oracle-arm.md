# Instalação Linux ARM na Oracle

Prefira uma VM ARM quando sua conta tiver capacidade; avalie o plano atual no
console Oracle. Não se assume cota Always Free, preço zero, número de OCPUs,
24 GB de RAM ou 200 GB de disco. Para 176 mil mídias, dimensione banco/índices,
derivados, temporários, WAL e backups com medições de uma importação pequena.

## Preparar host

Use distribuição Linux suportada, chave SSH e verifique fingerprint pelo console
Oracle. Instale Docker Engine/Compose seguindo documentação da distribuição,
atualize o sistema e configure horário UTC/NTP. Adicionar usuário ao grupo Docker
concede poder equivalente a root: restrinja-o ao administrador.

No iPhone, use SSH; não é necessário Mac para executar o núcleo. Clone por sua
credencial GitHub normal e guarde o projeto em `/opt/photointel`. Configure `.env`
sem exibir seus valores; modo 0600 e proprietário administrador.

```bash
cd /opt/photointel
python3 infra/scripts/setup-env.py
python3 infra/scripts/prepare-production-env.py
sudo bash infra/oracle/prepare-host.sh /opt/photointel
df -h
uname -m
```

O script cria sessão e temporários com UID 10001/modo 0700 e volume PostgreSQL
com UID 999/modo 0700. Confira UID da imagem selecionada quando alterar sua base.
Não aplique chmod amplo sobre dados PostgreSQL já existentes.

## Configuração e imagens

Siga [CLOUDFLARE_SETUP.md](../../CLOUDFLARE_SETUP.md). Configure produção, R2,
Access allowlist, origens HTTPS, pepper e Tunnel token. GPU/iCloud podem permanecer
desativados. Defina versões/digests de imagens em `PHOTOINTEL_IMAGE` e
`PHOTOINTEL_WEB_IMAGE`; a imagem deve suportar `linux/arm64`.

Produção usa dois arquivos 0600: `.env` controla Compose/Tunnel/PostgreSQL e
`.env.runtime` contém somente configuração e credenciais da aplicação. Não copie
senha administrativa ou `MIGRATION_DATABASE_URL` para `.env.runtime`.
`make setup` gera `POSTGRES_APP_PASSWORD` e `APP_DATABASE_URL` para o papel
`photointel_app`; revise o host `postgres` e nome do banco. Configure
`MIGRATION_DATABASE_URL` em `.env` com a credencial de bootstrap/migração para o
mesmo banco. O papel limitado não pode criar extensões ou alterar o schema.

Construa as imagens e configure os arquivos. Depois inicie apenas banco e
migração, conceda permissões ao papel limitado e só então inicie os processos:

```bash
docker buildx build --platform linux/arm64 -f infra/docker/api.Dockerfile -t photointel-api:SEU_COMMIT --load .
docker buildx build --platform linux/arm64 -f infra/docker/web.Dockerfile -t photointel-web:SEU_COMMIT --load .
PHOTOINTEL_COMPOSE_MODE=prod bash infra/scripts/compose.sh up -d postgres
PHOTOINTEL_COMPOSE_MODE=prod bash infra/scripts/compose.sh run --rm migrate
bash infra/oracle/provision-app-role.sh
PHOTOINTEL_COMPOSE_MODE=prod bash infra/scripts/compose.sh up -d
```

O script cria/atualiza somente o papel app definido, força NOSUPERUSER/NOCREATEDB/
NOCREATEROLE/NOBYPASSRLS e concede CRUD nas tabelas, uso de sequências e grants
padrão para objetos criados pelo papel bootstrap. Rode novamente após migrações
se forem usados outros donos de objetos; nesse caso ajuste os grants padrão ao
papel real de migração. API/worker não recebem a senha administrativa. Não use
o papel de aplicação como proprietário do banco, schema ou de papéis privilegiados.

No ambiente Codex gerenciado, builds precisam da CA do proxy fornecida com
`--secret id=build_ca,src=/etc/ssl/certs/ca-certificates.crt`. Preserve proxy,
trust TLS e política de rede. Falha de acesso ao socket/registro precisa de
recuperação/permissão do ambiente, sem ignorar TLS ou contornar a rede.

Limites no Compose são teto inicial por serviço, não dimensionamento garantido.
Compare a soma dos limites com a RAM/CPU da VM real e deixe margem para SO,
cache PostgreSQL, builds e WAL. Não rode modelos GPU no ARM Oracle por padrão.

## Rede e validação

Security lists/NSG e firewall do host devem permitir apenas SSH de origens
administrativas necessárias; a aplicação recebe tráfego pelo Tunnel de saída.
Nenhum container production publica porta no host. Não abra 5432, MinIO,
8000 ou 8080. R2/Modal/iCloud requerem saída HTTPS e Cloudflare Tunnel requer
conectividade de saída conforme documentação vigente.

Confirme login autorizado, email negado, JWT inválido, bucket privado, migração,
saúde, criação de job sintético, logs sem segredos e restore-test. Só depois
ative iCloud e classifique um lote pequeno. Registre as evidências e a versão
implantada; configurar arquivos não confirma que o servidor está publicado.
