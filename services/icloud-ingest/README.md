# Ingestão iCloud

> **Nota de revisão arquitetural (04/11/2026):** Este diretório descreve **responsabilidades de domínio**, mas não é por si só um microserviço Cloud Run independente: a execução real é implementada em `apps/api/src/photointel/services/ingestion.py`, `discovery.py` e no runner finito. Confira [a referência de código e fluxos](../../docs/architecture/INGESTION_AND_RECOVERY.md).

Runtime: `photointel.services.ingestion`. O scheduler agenda jobs PostgreSQL a cada
`INGESTION_INTERVAL_MINUTES` e atualiza heartbeat mesmo ocioso. O worker executa
runs finitos. Nada remove ou modifica fotos Apple.

A integração usa a implementação Python distribuída com **icloudpd 1.32.3**, cuja
assinatura foi conferida nos fontes oficiais dessa tag em 15/10/2026:

- https://github.com/icloud-photos-downloader/icloud_photos_downloader/blob/v1.32.3/src/pyicloud_ipd/base.py
- https://github.com/icloud-photos-downloader/icloud_photos_downloader/blob/v1.32.3/src/pyicloud_ipd/services/photos.py
- https://github.com/icloud-photos-downloader/icloud_photos_downloader/blob/v1.32.3/src/icloudpd/cli.py

São APIs não oficiais do iCloud e internas do downloader. Outra versão é recusada
até validar compatibilidade. Não há inferência de identidade PhotoKit a partir do
ID do downloader. A listagem retorna IDs do master record; URL assinada não é
persistida nem enviada ao frontend.

A política equivalente CLI seria `--size medium --force-size`; o adapter lê
`photo.versions[AssetVersionSize.MEDIUM]`, verifica tamanho antes do streaming e
não faz fallback. `ALLOW_ORIGINAL_FALLBACK=true` autoriza explicitamente original,
ainda sujeito aos limites por arquivo e execução. Vídeos ficam no catálogo.
Recursos Live Photo referenciados não criam um segundo asset lógico.

## Terminal seguro no iPhone

```bash
uv sync --group ingest
uv run python -m photointel.services.icloud_admin authenticate
uv run python -m photointel.services.icloud_admin verify
uv run python -m photointel.services.icloud_admin libraries
uv run python -m photointel.services.icloud_admin test
uv run python -m photointel.services.icloud_admin status
uv run python -m photointel.services.icloud_admin reauthenticate
uv run python -m photointel.services.icloud_admin clear --confirm-clear-session
```

A autenticação exige TTY e usa `--password-provider console --auth-only`. Senha e
2FA vão só aos prompts interativos. O app não solicita, guarda ou transmite senha.
Cookies/sessão: diretório 0700, arquivos 0600. `clear` elimina só credenciais locais;
não revoga sessões nos servidores Apple. Revogue a conta pelo dashboard Apple em
caso de comprometimento. Verificação online só é considerada recente por 65 minutos;
a simples presença de cookies nunca é tratada como autenticação válida.

Cada execução respeita `INGESTION_IMPORT_LIMIT` (100 inicial),
`MAX_DOWNLOAD_BYTES` e `MAX_RUN_DOWNLOAD_BYTES`. Runs sucessivos continuam por
um cursor persistido. Uma rotação completa reconcilia ausências; mudanças na
ordenação Apple exigem rotações periódicas e não podem disparar exclusões.

Fixtures controladas usam `generate_fixtures()` e são explicitamente identificadas
como demonstração; resultados AI sintéticos só existem com `APP_ENV=test`.

Descobertas simultâneas da mesma conta/biblioteca são serializadas por lock
transacional PostgreSQL, protegendo cursor e arquivos parciais. Todo acesso a
objetos do downloader, inclusive propriedades potencialmente lazy, ocorre na
fronteira síncrona executada em thread, preservando o event loop do heartbeat.
Retomada de HTTP Range exige `Content-Range` compatível com offset e tamanho.

Renomear ou corrigir metadados de um asset não muda sua revisão de conteúdo.
Snapshots separados de metadados registram essas alterações sem baixar a mesma
representação novamente. A prova de autenticação é vinculada à conta e à
biblioteca selecionadas, além do limite de validade temporal.
