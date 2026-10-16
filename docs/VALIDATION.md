# Evidências de validação

Este registro distingue implementação, execução controlada e integração externa.
As suítes locais controladas passaram; a existência do código não comprova o
cenário de aceitação completo com iCloud, GPU e PhotoKit reais.

## Checkpoints publicados

| Commit remoto | Conteúdo |
| --- | --- |
| `fcb8eb7` | Primeiro conjunto integrado: API, PWA, serviços, Bridge e infraestrutura |
| `c4eb115` | Pipelines duráveis e bootstrap de CI executável |
| `edb2df8` | Locks, OpenAPI, revisões verificadas dos modelos e testes de interface |
| `29e5b8b` | Correções de validação, Keychain público e build do MinIO oficial |

O histórico inclui também mudanças do operador. As atualizações automatizadas
usam o head esperado e preservam os commits existentes, sem force push.

## Execuções concluídas

[Bootstrap 38808843904](https://github.com/rodkisten/photointel/actions/runs/38808843904)
executou no GitHub Actions:

- Instalação Python, export OpenAPI e geração dos tipos: passaram.
- Mypy: passou. Pytest: **116 passaram, 16 desmarcados**, sem GPU real.
- Imagem API AMD64 e imports `cv2`, `pillow_heif`, `psycopg`: passaram.
- Auditorias de dependências: passaram nesse checkpoint.
- A integração não iniciou: pull do MinIO recusado. As falhas web foram corrigidas
  em seguida. Essa execução completa falhou, como esperado.

[Validate 38809588711](https://github.com/rodkisten/photointel/actions/runs/38809588711)
e [Bootstrap 38809589016](https://github.com/rodkisten/photointel/actions/runs/38809589016)
executaram no checkpoint `29e5b8b`:

- Ruff: passou. Pytest no bootstrap: **160 passaram, 28 desmarcados**.
- Frontend: lint, TypeScript, **18 testes**, build e npm audit com **zero
  vulnerabilidades** passaram no job dedicado.
- Mypy identificou um erro de tipo em `gpu/service.py`, corrigido no código
  subsequente; a correção ainda exige nova execução.
- O build do MinIO estava em andamento quando outro push cancelou os workflows.
  Migrations, restauração, integração, E2E e benchmark não foram executados nessa
  rodada. Cancelamento não é resultado aprovado.

Verificações locais adicionais efetivamente executadas:

- Ruff check e format check de todo o Python, com o executável do CI e hash do
  artifact verificado.
- `compileall` de API, GPU, Bridge e testes.
- `python tests/worker_core_smoke.py`: **29 verificações** do núcleo do worker.
- `python -m unittest discover -s tests -p test_pyto_keychain.py`: **28 testes**
  portáveis da política Keychain com backend de teste; nenhum Keychain Apple real.
- Parse de Compose development/production sem daemon e verificações de sintaxe
  shell: passaram. Isso não equivale a `docker compose up` concluído.

## Primeiro exercício real de infraestrutura

[Bootstrap 38810056593](https://github.com/rodkisten/photointel/actions/runs/38810056593)
executou no commit `38ab4e4`:

- MinIO oficial compilado, iniciado e bucket privado acessível: passou.
- Alembic até `0003`, provisionamento do papel limitado da aplicação: passaram.
- `pg_dump`/`pg_restore` em dois bancos sintéticos, 16 imagens e fingerprints de
  todas as tabelas: passou.
- Integração com PostgreSQL e MinIO: **26 passaram e 2 falharam**. As falhas
  identificaram a normalização de palavras em nomes como `garden.jpg`.
- Benchmark com 10.000 metadados: inserção 0,549 s; medianas de cinco amostras
  de galeria 0,685 ms, próxima página 0,744 ms e filtro 0,588 ms, 60 resultados
  por consulta. Planos usaram `ix_assets_capture_cursor`. São medições no runner
  x86_64 PostgreSQL 16.15/pgvector 0.8.7, com cache possivelmente aquecido; não
  representam percentis nem desempenho da biblioteca real.
- FTS retornou zero candidatos nessa execução e não teve sua performance
  validada. [Relatório original](evidence/benchmark-10000-before-fts-fix.json).
- A ausência do lock npm provocou resolução inconsistente de `ajv` e bloqueou
  instalação/E2E; a versão anteriormente validada será restaurada. Não trate
  resolução automática como substituto de um lock revisado e testado.

## Validação com todas as dependências locais

[Bootstrap 38812662508](https://github.com/rodkisten/photointel/actions/runs/38812662508)
no commit `3bc23a2` passou em todos os checks obrigatórios, exceto E2E:

- **182 testes Python unitários**, **34 testes de integração** e **28 testes web**
  passaram. Ruff, Mypy, ESLint, TypeScript, OpenAPI e build passaram.
- MinIO, bucket privado, migrations até `0004`, papel SQL limitado, dump/restore,
  imagem API AMD64 e auditorias passaram.
- E2E: **26 passaram, 5 falharam e 1 foi desmarcado**. As falhas localizaram um
  painel de metadados aberto interceptando zoom e labels que incluíam opções
  dos selects. As correções precisam de nova execução; não é uma suíte aprovada.
- As capturas reais do catálogo sintético estão no artifact `validation-evidence`,
  em `reports/previews/`, com manifesto de origem e garantia do modo de teste.

Medições PostgreSQL no mesmo runner, sem inferência de modelo real:

| Metadados | Inserção | Galeria, mediana | FTS, mediana | Resultados por página |
| --- | --- | --- | --- | --- |
| 10.000 | 0,918 s | 0,756 ms | 0,703 ms | 60 |
| 100.000 | 12,070 s | 0,836 ms | 0,693 ms | 60 |
| 176.000 | 21,070 s | 0,730 ms | 0,708 ms | 60 |

Com **10.000 vetores sintéticos normalizados de 768 dimensões**, a inserção com
HNSW levou 16,895 s; ANN retornou 20 resultados com mediana 1,547 ms, contra
28,449 ms da referência exata SQL. O plano observou o índice HNSW e recall@20
foi **0,90 em uma única consulta sintética**. Isso não mede a qualidade semântica,
concorrência, cache frio ou a busca sobre 176 mil embeddings.

Relatórios originais com amostras e planos: [10k](evidence/benchmark-10000.json),
[100k](evidence/benchmark-100000.json), [176k](evidence/benchmark-176000.json) e
[10k vetores](evidence/benchmark-vectors-10000.json). São cinco amostras por
consulta, cache possivelmente aquecido e latência cliente incluindo configuração
de timeout. Não são garantias de latência no Oracle nem percentis de carga.

## Inferência real validada em CPU

[Real CPU 38830862284](https://github.com/rodkisten/photointel/actions/runs/38830862284)
passou no commit `eb6b6b1`, em branch explícita `validation/real-cpu`, sem credenciais
Modal ou GPU:

- Pesos reais fixados: JoyTag retornou **5.813 probabilidades** finitas em [0,1].
- SigLIP 2 retornou **768 dimensões**, norma da imagem 0,999999956.
- Imagem e texto usaram a mesma revisão. Cossenos finitos para duas frases em
  português: 0,11869 ("Paisagem com montanhas") e 0,04927 ("Fotografia de uma planta").
- A gravação de ambos os inference runs e do embedding foi verificada numa
  nova sessão PostgreSQL depois do commit.
- PyTorch `2.14.1+cpu`, torchvision `0.29.1+cpu`, Transformers `4.57.6`;
  duração observada 31,45 s incluindo carregamento dos modelos e teste.

[Relatório original](evidence/real-cpu-model-validation.json). Uma imagem sintética
não valida acurácia, abrangência multilíngue, CUDA, implantação Modal ou custos do
provedor. As limitações de conta, hardware e bibliotecas reais continuam vigentes.

## Gate completo aprovado

[Bootstrap 38830845571](https://github.com/rodkisten/photointel/actions/runs/38830845571)
e [Validate 38830845612](https://github.com/rodkisten/photointel/actions/runs/38830845612)
passaram no checkpoint `eb6b6b1`:

- 182 testes Python unitários e 34 de integração passaram.
- 31 testes frontend passaram.
- E2E Chromium: **31 passaram e 1 foi desmarcado**; a captura restrita a iPhone
  é intencionalmente desmarcada no projeto desktop.
- Todos os demais checks obrigatórios passaram, incluindo lint, tipos, contratos,
  build, MinIO, migrations, restauração, papel SQL limitado, benchmarks e auditorias.

[Outcomes originais](evidence/validation-core.json). São testes controlados com
fixtures; não configuram nem validam iCloud, Access/R2 ou Modal de uma conta real.
A inferência CPU real tem evidência separada e não usa o adapter determinístico.

Os dois gates também passaram no checkpoint `194acb6`:
[Bootstrap 38831565488](https://github.com/rodkisten/photointel/actions/runs/38831565488)
e [Validate 38831565408](https://github.com/rodkisten/photointel/actions/runs/38831565408).

## Navegação WebKit no perfil de iPhone

[WebKit 38831575164](https://github.com/rodkisten/photointel/actions/runs/38831575164)
passou no commit `194acb6`: **46 testes passaram, 2 foram desmarcados
intencionalmente e nenhum falhou**. A execução reúne Chromium mobile/desktop e
WebKit Linux no perfil iPhone 13; os 15 fluxos da aplicação passaram em WebKit.
As duas capturas desmarcadas são restritas ao projeto Chromium mobile.

O [relatório permanente](evidence/webkit-validation.json) registra o JUnit e o
hash SHA256 do artifact conferido. Isso não valida Safari num iPhone físico,
instalação da PWA, Keychain ou PhotoKit. As capturas de preview no artifact foram
feitas em Chromium; não são capturas de Safari real.

## Containers AMD64 e ARM64

[Arquiteturas 38832588645](https://github.com/rodkisten/photointel/actions/runs/38832588645)
passou no commit `89a325b`: **as seis combinações API/web/MinIO × AMD64/ARM64
foram construídas e executadas com sucesso**, sem publicar imagens ou implantar
serviços. A API executou extensões nativas e primitivas de processamento; Nginx
serviu health e o build real; MinIO executou o binário da revisão fixada.

O [relatório permanente](evidence/container-architectures.json) registra os seis
artifacts com SHA256 conferido, arquiteturas, digests e saídas de execução. ARM64
usou QEMU sobre AMD64; não mede performance, disco, permissões ou operação do
Compose num host Oracle real. Nenhuma GPU ou conta de produção foi acessada.

## Como interpretar os artifacts

O workflow bootstrap mantém passos independentes com `continue-on-error` para
coletar evidência de todas as áreas. A conclusão visual de um passo pode mascarar
essa condição. A autoridade é **`reports/validation.json`**, com o `outcome` real
de cada check. O último passo exige sucesso em todos os checks obrigatórios.

Artifacts gerados:

- `generated-locks-contracts`: `uv.lock`, lock npm, OpenAPI e schema TypeScript.
- `validation-evidence`: JUnit, logs operacionais sintéticos, benchmarks e restore
  quando executados, relatórios de dependências e referências públicas.
- `validation-tools`: Ruff para correções offline, acompanhado de versão e hash.

As capturas em `reports/previews/` só existem se Playwright realmente executou.
O teste exige ambiente de teste, catálogo exclusivamente sintético e mídia
procedural limitada. Não exporta imagens de uma biblioteca pessoal.

## Integrações que ainda exigem validação externa

| Integração | Implementado | Evidência ainda necessária |
| --- | --- | --- |
| iCloud | Adapter 1.32.3, sessão, limites, cursores e recuperação | Login/2FA, biblioteca e importação real de até 100 imagens |
| JoyTag | Pipeline oficial e smoke com pesos reais em CPU aprovados | CUDA/Modal, qualidade na biblioteca real e custo |
| SigLIP 2 | Imagem/texto 768D e persistência com pesos reais aprovados em CPU | CUDA/Modal, qualidade de recuperação em português e custo |
| Modal | ASGI autenticado, cache, GPU e orçamentos | Deploy e chamada autenticada com credenciais reais |
| Cloudflare | Validação JWT, Pages/Tunnel/R2 e configuração Access | Provisionar conta e testar login, mídia e credenciais de serviço |
| Oracle ARM | Build/execução API, web e MinIO AMD64/ARM64 aprovados; Compose e runbooks | Exercício completo no host de destino; ARM CI usa QEMU |
| Pyto | PhotoKit read, Keychain público, protocolo seguro | Permissão, entitlements e APIs no iPhone real |
| Keywords Apple | Diffs, aprovações, conflitos e bloqueios | API disponível e adapter validado numa foto selecionada; bulk continua desabilitado |

Os metadados públicos dos checkpoints estão versionados em
`packages/configuration/`. O smoke CPU separado conferiu efetivamente 5.813
probabilidades JoyTag e embeddings SigLIP 2 de 768 dimensões com pesos reais.
Isso não comprova processamento GPU nem inferência sobre 176 mil fotografias.
