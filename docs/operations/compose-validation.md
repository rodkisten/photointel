# Validação do caminho local completo

O workflow `Validate developer Compose` executa o caminho documentado em um runner
isolado do GitHub Actions. Ele só inicia por `workflow_dispatch` ou push na branch
`validation/compose`; não implanta produção, não usa credenciais externas, não
autentica iCloud e mantém `GPU_ENABLED=false`.

O exercício usa `make setup` com os lockfiles versionados e `.env` privado com
credenciais locais aleatórias. Depois executa `make dev`, `make migrate`,
`make seed ASSETS=16`, repete a importação, executa `make stop` e `make dev`.
O build usa o MinIO real compilado da revisão upstream fixada; o cache só evita
compilar dependências novamente e não substitui o servidor por uma simulação.

O wrapper `infra/scripts/compose.sh` usa `COMPOSE_BAKE=false` por padrão. O caminho
BuildKit do Compose aceita o certificado configurado em `BUILD_CA_FILE` como secret
de build sem a permissão adicional de filesystem que o Bake exige para arquivos
fora do contexto. A verificação TLS permanece ativa, e o certificado não é copiado
para o repositório. Habilitar Bake explicitamente exige configurar suas permissões
de leitura separadamente.

`make seed` roda dentro do contêiner API. As imagens sintéticas e os jobs usam o
mesmo volume `processing` do worker, evitando caminhos que só existam no host.
Para usar a CLI diretamente no host fora do Compose, configure um worker com
acesso ao mesmo `TEMP_DIRECTORY`; não misture o caminho local e o volume nomeado.

O verificador exige saúde real de PostgreSQL, MinIO, API, worker, ingestion e
frontend; a saúde dos dois processos em segundo plano usa seus heartbeats.
Também exige o bundle web servido pelo Nginx, migrations reaplicáveis, galeria
com 16 itens, três derivados privados por foto, jobs concluídos sem falhas,
bucket sem listagem anônima, GET anônimo de um derivado real bloqueado com HTTP 403
e tags de origem `import`. Nenhum inference run pode existir nesse exercício.

Contagens e fingerprints de identidade, revisões, tags e bytes dos derivados
devem permanecer iguais após a importação repetida e após o reinício. A evidência
fica no artifact `developer-compose-validation`; ela contém saúde, contagens e
hashes. Em falhas de startup, somente nesse workflow isolado, o coletor também
seleciona frames de traceback e resumos de exceções das últimas 100 linhas dos
serviços com falha. Valores sensíveis reais do `.env` e do ambiente, URLs e valores
longos são redigidos antes da seleção. Linhas arbitrárias e logs brutos, `.env`,
credenciais, fotos e metadados individuais não são publicados. O cleanup encerra
apenas o projeto isolado do runner
e preserva os volumes, sem `down -v`.

A existência do workflow não comprova execução bem-sucedida. Consulte os resultados
da execução e os arquivos JSON de cada fase. Essa validação não substitui um
exercício no Oracle, autenticação Cloudflare, ingestão Apple ou inferência Modal.
