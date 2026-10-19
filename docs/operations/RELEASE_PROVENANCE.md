# Proveniência de release

Um relatório de uma versão anterior não comprova a versão instalada. O manifesto
v1.1 associa informações somente ao SHA de origem, sem segredos e sem afirmar que
houve implantação ou inferência real.

## Geração

Depois de revisar e fazer commit das alterações, no Codespaces:

```bash
python infra/scripts/release-manifest.py --output reports/release-manifest.json
```

O comando rejeita árvore suja e múltiplos heads Alembic. Inclui SHA, branch, data,
versão API, migration head, revisões JoyTag/SigLIP 2 e SHA-256 dos arquivos de
infraestrutura rastreados. Não lê `.env` ou credenciais. Digests de imagem e IDs
de implantação não conhecidos ficam `null`, sem IDs inventados.

Depois de uma build real, acrescente o digest obtido do Artifact Registry:

```bash
python infra/scripts/release-manifest.py \
  --container-digest 'sha256:DIGEST_REAL_DE_64_HEXADECIMAIS' \
  --ci-run-id 'ID_REAL_DA_EXECUCAO' \
  --output reports/release-manifest.json
```

O exemplo exige substituir os valores; o validador rejeita um digest inválido.
O workflow manual **Generate release provenance (no deployment)** produz o
artefato sem criar recursos, gastar GPU, publicar imagens ou executar testes.
Um ID desse workflow identifica geração, não aprovação de testes.

Para vincular testes executados, forneça `--test-results arquivo.json`, contendo
uma lista apenas de `git_sha`, `name`, `status` e `reference`. Cada `git_sha` deve
ser exatamente o SHA atual. `status` aceita `passed`, `failed` ou `not_run`.
`reference` aceita caminho relativo de relatório ou URL de execução GitHub
Actions, sem parâmetros de credenciais. Não coloque o conteúdo de logs, fotos,
cookies ou segredos no arquivo.

## API e interface

Disponibilize o arquivo no container e configure
`PHOTOINTEL_RELEASE_MANIFEST=/app/release-manifest.json`. Como identificação
mínima, use `RELEASE_GIT_SHA` e `RELEASE_BRANCH`. `GET /v1/release` é protegido
pela mesma autorização dos demais endpoints administrativos.

A leitura usa allowlist e limite de 64 KiB. Campos desconhecidos são descartados,
referências de outro SHA são omitidas e manifesto ausente ou inválido resulta em
`unidentified`/`unverified`. `/setup` mostra os campos seguros e as referências. A build web recebe
`VITE_RELEASE_ID` com o SHA e bloqueia o registro de gates se diferir da API.
O workflow Pages identifica a build com `github.sha`.
`validation_status=referenced` significa que existem referências, não que o
servidor verificou o provedor externo ou auditou os relatórios por conta própria.

`--allow-dirty` serve somente para diagnóstico local, com
`provenance_status=dirty`; evidências desse estado não devem aprovar uma release.
Gates de integração real continuam separados e exigem verificação explícita.

## Atualização e rollback

Gere o manifesto da imagem que será executada. Após rollback, use novamente o
manifesto daquela imagem e consulte `/v1/release`; não copie evidências do build
mais novo para o antigo. Antes de ampliar a biblioteca, confira que os gates
apontam para o SHA instalado e que as revisões de modelo não mudaram.
