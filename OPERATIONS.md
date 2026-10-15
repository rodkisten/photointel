# Operação e recuperação

Comece com 100 mídias e GPU desativada. Aumente ingestão depois de observar bytes,
latência, erros, disco, fila e custo. Lote 8/concorrência 1 são limites prudentes;
não representam throughput medido para 176 mil mídias.

## Rotina diária pelo iPhone

Use SSH com chave e verificação de host. O aplicativo e credenciais rodam no
servidor; não é necessário compilar no iPhone nem abrir Mac/Xcode.

```bash
cd /opt/photointel
PHOTOINTEL_COMPOSE_MODE=prod bash infra/scripts/compose.sh ps
PHOTOINTEL_COMPOSE_MODE=prod bash infra/scripts/compose.sh logs --tail=100 api worker ingestion
PHOTOINTEL_COMPOSE_MODE=prod bash infra/scripts/compose.sh exec -T api python -m photointel.cli doctor --json
df -h
du -sh var/postgres var/processing var/icloud-downloads backups
```

Não cole logs sem revisar dados pessoais. Não execute `env`, `docker inspect`,
`cat .env`, `cat .env.runtime`, nem imprima cookies/chaves para coletar um diagnóstico. Identificadores
de mídias e metadados também são privados.

API tem healthcheck HTTP; worker/ingestion escrevem heartbeat do event loop em
`/tmp` e ficam unhealthy quando ausente ou com mais de 120 segundos. Isso mede
vida do processo. Readiness iCloud/GPU/Apple é distinta e exige diagnóstico e
exercício real. Docker `restart: unless-stopped` reinicia processos que encerram;
estado unhealthy sozinho não causa reinício automático.

## Backup

```bash
PHOTOINTEL_COMPOSE_MODE=prod make backup
```

O script gera `backups/AAAA.../postgres.dump`, metadados CSV/JSON e manifest SHA-256
em diretório 0700. Dump completo preserva vetores; exportação de portabilidade
não inclui embeddings. A exportação e o dump são feitos sequencialmente, por isso
não representam uma transação única: para um ponto perfeitamente coordenado,
pause ingestão/worker e alterações pela API durante o backup.

Com `BACKUP_AGE_RECIPIENT` configurado e `age` instalado, o script gera também
`backup.tar.age`; cópias locais privadas permanecem para recuperação. Copie o
arquivo criptografado para destino separado e gerencie a retenção fora do script.
Não guarde a chave de descriptografia junto ao backup. Derivados R2/MinIO precisam
de política/cópia própria; os originais iCloud não são backup deste projeto.

## Testar o procedimento

```bash
make restore-test
```

O teste cria **dois bancos scratch**, migra um, insere 16 mídias sintéticas,
calcula hashes e contagens por tabela, executa `pg_dump`/`pg_restore` no outro e
compara a totalidade da fixture. Ao terminar remove apenas esses bancos e arquivos
temporários, deixando `reports/restore-test.json` quando passou.
Ele não comprova restauração do seu backup real nem disponibilidade de objetos
R2. Execute-o no mesmo PostgreSQL/imagem de produção após upgrades.

Para ensaiar um dump real, use host isolado, mesmo major PostgreSQL/extensões,
novo banco e `pg_restore --no-owner --no-acl --exit-on-error`. Verifique o manifest,
contagens, tags revisadas, jobs, snapshots/mapeamentos e amostra de recursos R2.
Não substitua a base ativa durante um ensaio. Faça novo login iCloud no destino
em vez de expor sessão antiga. Só troque a aplicação para o banco restaurado após
revisão dos resultados e backup da instalação anterior.

## Atualização e rollback

Registre commit, imagens/digests e versão Alembic implantados. Construa imagens
ARM64 no CI ou host compatível, pause novos jobs, faça backup e aplique migração.
Inicie API e confirme readiness antes de retomar workers. Se a migração alterar
dados irreversivelmente, rollback exige restore testado; trocar somente o tag da
imagem pode não ser compatível com o schema novo.

```bash
PHOTOINTEL_COMPOSE_MODE=prod bash infra/scripts/compose.sh pull
PHOTOINTEL_COMPOSE_MODE=prod bash infra/scripts/compose.sh up -d
```

Esses comandos usam os tags configurados. Em produção substitua tags locais por
versões fixas/digests revisados. Não atualize banco e modelos sem verificar
compatibilidade/dimensão do embedding.

## Falhas e limites

| Sintoma | Verificação inicial |
|---|---|
| API não pronta | Migração, conexão PG, auth/armazenamento production |
| Jobs parados | Worker em execução, heartbeat, lease, attempts e erro persistido |
| iCloud requer autenticação | Login interativo no diretório da sessão correto |
| Representação indisponível | Tamanho/formato permitido; não habilite original automaticamente |
| GPU desabilitada | Revisões/token/backend configurados e orçamento revisado |
| Apple `mapping_required` | Mapeamento verificado no dispositivo e revisão atual |
| Disco crescendo | PostgreSQL/WAL, backups retidos, temporários; jamais apague originais |
| Access em loop | Hostnames/políticas, API session, CORS e cookies no Safari |

Os limites de GPU estimam trabalho e custo. Habilite alertas/limites do provedor
e monitore uso faturado; execução/cold start/preço real podem divergir das
estimativas. Pausar lote não necessariamente encerra uma chamada GPU já iniciada.

`python3 infra/scripts/cleanup-temp.py` faz dry-run; `--apply` remove arquivos
expirados apenas em `var/processing` deste repositório, recusando symlinks de diretório. Não use esse script sobre
downloads, sessão ou biblioteca. Derivados permanentes só podem ser regenerados
se a representação necessária continuar disponível.
