# Backup e recuperação completos

O backup novo inclui **bytes reais dos derivados privados**, além do dump
PostgreSQL. Um inventário R2 sozinho não preserva o conteúdo dos objetos. O
comando legado `make backup` continua disponível para compatibilidade; seu
manifesto v1 declara explicitamente `object_storage_included=false`. Para uma
cópia completa use `make backup-application` ou a CLI abaixo.

O formato `photointel-application-backup-v2` é um diretório portátil: `backup.json`
contém apenas identificador, versão, key ID e checksum do manifesto criptografado;
`manifest.enc` contém metadados privados e a lista autenticada de arquivos;
`chunks/*.enc` contém o dump, exportações e conteúdo de cada objeto. Cada chunk
usa AES-256-GCM com nonce aleatório de 96 bits e AAD vinculando backup, arquivo e
índice. Nomes de objetos, dados pessoais e hashes de credenciais do dump ficam
criptografados. Não é necessário guardar uma cópia em claro do dump.

## Pré-requisitos e cópia

Use Codespaces ou Cloud Shell com `uv sync` e os utilitários oficiais `pg_dump` e
`pg_restore`. A versão do cliente deve ser igual ou mais recente que a versão do
servidor PostgreSQL; por exemplo, PostgreSQL 17 exige cliente 17 ou superior.
Verifique `pg_dump --version` e a versão no dashboard Neon. O container da API
não precisa incluir esses clientes. Para Neon, use a conexão **direta** em
`MIGRATION_DATABASE_URL`, com TLS e permissões de leitura/exportação do snapshot;
reserve o endpoint pooled para a API. Não passe senha dentro de argumentos CLI.

Configure `DATABASE_URL`, `MIGRATION_DATABASE_URL` e o storage privado de origem
no ambiente protegido do terminal. Crie uma chave de backup diferente da chave
Apple, sem imprimi-la:

```bash
umask 077
mkdir -p "$HOME/.config/photointel"
python -c 'import base64,secrets; from pathlib import Path; p=Path.home()/".config/photointel/backup-key"; p.write_bytes(base64.b64encode(secrets.token_bytes(32))); p.chmod(0o600)'
uv run python -m photointel.services.backup create \
  --directory "backups/release-$(date -u +%Y%m%dT%H%M%SZ)" \
  --key-file "$HOME/.config/photointel/backup-key"
```

Anote o diretório criado e use-o nos próximos comandos. A chave precisa de cópia
independente segura: sem ela não existe recuperação. O caminho deve ser novo;
o programa não sobrescreve um backup anterior.

A cópia PostgreSQL usa snapshot consistente de `pg_export_snapshot` com
`pg_dump --snapshot`. O mesmo snapshot produz o inventário dos derivados
persistentes, versões Alembic, fingerprints por tabela e exportações de taxonomia,
aliases, model registry e álbuns. Mappings, embeddings, revisões, jobs e auditoria
são preservados no dump. Somente parâmetros explicitamente permitidos entram no
manifesto de configuração; URLs, contas, chaves e tokens são excluídos.

A transação read-only do snapshot termina **antes** das transferências R2. Derivados
são imutáveis por revisão; faça o backup sem uma manutenção concorrente removendo
objetos antigos. Um objeto ausente ou divergente invalida a cópia em vez de gerar
um backup silenciosamente incompleto. Inputs temporários de inferência e originais
iCloud não são copiados; inputs podem ser regenerados. Snapshots de sessão Apple
ativos entram como ciphertext, além da criptografia própria do backup.

## Segunda cópia e custo

Mova o diretório completo, já criptografado, para um destino independente do bucket
primário: disco persistente privado ou segundo bucket privado de outro provedor/
conta. Um exemplo manual, somente após autorizar armazenamento e custos:

```bash
gcloud storage cp --recursive backups/SEU_BACKUP gs://SEU_BUCKET_PRIVADO_DE_BACKUP/
```

Não crie esse bucket automaticamente. Cloud Shell e Codespaces podem expirar;
não são, sozinhos, uma política de retenção durável. O custo inclui a segunda
cópia dos thumbnails/previews, dump, operações de leitura/escrita e possível egress.
Uma regra 3-2-1 é recomendada. Preserve chave e cópia em locais de confiança
separados. A aplicação não define nenhum bucket como público.

## Verificação antes de migrar

```bash
uv run python -m photointel.services.backup verify \
  --directory backups/SEU_BACKUP \
  --key-file "$HOME/.config/photointel/backup-key" \
  --verification-receipt backups/SEU_BACKUP/verification.json
```

Esse comando descriptografa e verifica todos os chunks, tamanhos e SHA-256,
sem escrever conteúdo em claro. O recibo inclui backup ID, checksum do manifesto,
data, quantidades e `verification_kind=authenticated-content-integrity`.
**Integridade não prova restauração do banco.** O guard de migração pode conferir
esse recibo como evidência fornecida pelo operador; um JSON local não é uma
atestação independente nem substitui um teste de restore.

## Restore isolado

1. Pause despachos e limpeza no destino. Preserve o sistema anterior para rollback.
2. Crie explicitamente um banco vazio `pi_restore_*` e bucket/diretório privado
   separados. Nunca aponte uma simulação para o banco ou bucket principal.
3. Configure os URLs e storage **do destino**, preserve o backup e a chave fora
   dele e execute:

```bash
uv run python -m photointel.services.backup restore \
  --directory backups/SEU_BACKUP \
  --key-file "$HOME/.config/photointel/backup-key" \
  --confirm-database pi_restore_VALIDACAO \
  --verification-receipt backups/SEU_BACKUP/restore-verification.json
```

O nome precisa coincidir com o URL. O padrão aceita somente banco isolado
`pi_restore_*`; uma restauração definitiva exige `--allow-production-target`
mais a confirmação exata do nome, decisão explícita do operador. Não há
`DROP`, `--clean` nem sobrescrita de objetos divergentes.

Todos os chunks são verificados antes de tocar o destino. O banco deve estar
vazio ou ter fingerprints idênticos ao mesmo backup, permitindo continuar uma
restauração interrompida durante a cópia dos objetos. O programa restaura o dump,
copia os objetos preservando as chaves, confirma leitura/checksum de cada um e
compara fingerprints de **todas as tabelas** e head Alembic. Um objeto divergente
no destino bloqueia a operação; uma preview faltante pode ser reposta numa nova
execução. Falha parcial do próprio `pg_restore` exige um novo banco vazio; não
esvazie automaticamente um banco com dados.

Após o restore, aplique migrações novas em Job separado apenas depois de backup
verificado. Execute health checks, abra previews autenticadas, confira tags,
álbuns, versões dos modelos e recuperação dos leases expirados antes de retomar
workers. Um restore não comprova acesso Apple, Modal ou autenticação Cloudflare.

## Teste reproduzível sem dados privados

Com `APP_ENV=test`, PostgreSQL acessível e permissão de criar bancos descartáveis:

```bash
uv run python infra/scripts/backup-restore-ci.py
```

Se o servidor de teste está num container e os clientes não estão instalados no
host, o script permite o nome explícito desse container:

```bash
uv run python infra/scripts/backup-restore-ci.py \
  --postgres-container photointel-v11-postgres
```

O script cria e remove somente seus dois bancos `pi_restore_*`, aplica todas as
migrações, gera três PNGs sintéticos, um embedding sintético de 768 dimensões,
tag, álbum e job, faz dump e backup criptografado, restaura tudo, decodifica as
imagens, testa repetição, reposição de preview ausente e detecção de corrupção.
O relatório sem segredos fica em `reports/application-restore-test.json`.
Isto valida o mecanismo local; recuperação real de Neon e R2 exige credenciais
e um destino privado autorizado. Backup de metadados/derivados não substitui
backup independente dos originais mantidos em iCloud.
