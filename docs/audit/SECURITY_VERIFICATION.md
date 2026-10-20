# Verificação de segurança v1.1

Este relatório cobre testes locais do código; não é atestado de implantação na
conta Cloudflare/Google nem teste físico de Safari/Pyto. A associação com o SHA
da release é produzida pelo manifesto e pelos relatórios finais da execução.
Nenhum recurso pago foi criado nesta verificação e nenhuma foto pessoal foi usada.

## Fronteira de autenticação

A API continua validando JWT Access RS256, issuer HTTPS exato da equipe,
audience, `exp`, `iat`, subject e allowlist de email para usuários. Não confia em
`Cf-Access-Authenticated-User-Email`, `X-Forwarded-*` ou proteção somente do frontend.

As rotas `/v1/bridge/*`, incluindo matrícula, exigem JWT de **outra aplicação
Access**, `sub` vazio e `common_name` com Client ID exato na allowlist. Depois
exigem código de matrícula de uso único ou Bearer Bridge próprio não revogado.
Service Auth não concede acesso ao catálogo/administrador; não há fallback de
JWT humano para serviço. Configuração ausente fecha o Bridge em produção.

A topologia Cloud Run escolhida permite rede pública `run.app`; autorização da
aplicação impede acesso privado sem JWT. O Worker Cloudflare usa upstream fixo,
não funciona como proxy arbitrário, não encaminha identidade email/proxy headers
crus e não segue redirects. Os endpoints privados continuam autenticados quando
a borda é contornada. Cloud Run IAM para disparar Jobs é um domínio de autorização
separado; JWT Access não substitui ID token/OAuth Google.

JWT já emitido não é revogado magicamente pelo verificador offline. A revogação
imediata do Bridge exige remover Client ID da allowlist e revogar o dispositivo;
a borda não emite novas sessões depois da revogação do Service Token. O prazo
`exp` limita o token anteriormente emitido. Rotação de humanos também requer
política Access/allowlist e verificação da sessão real.

## Mídia privada

Apenas object keys selecionadas pelo banco para a revisão corrente são usadas.
Não existe parâmetro de key/caminho arbitrário na rota. O proxy retorna chunks
até 64 KiB e fecha streams em conclusão, erro, resposta truncada e desconexão
antes do primeiro chunk. Libera a transação de leitura antes de acessar storage.
Ranges múltiplos ou inválidos são recusados; R2 precisa confirmar intervalo e
tamanho total. `ETag` inclui ID/revisão/checksum sem publicar esses valores.
A autenticação ocorre antes de 304/416, portanto condicionais não concedem acesso.

`Cache-Control: private, no-store` permanece; Worker também recusa cache CDN.
Não foi adicionado cache de fotos ao service worker, IndexedDB ou artefato público.
Ranges/streaming reduzem alocação e permitem leitura parcial, mas não prometem
redução de banda na rolagem repetida com a política no-store atual.

Benchmark reproduzível:

```bash
uv run --frozen python infra/scripts/benchmark-private-media.py \
  --output reports/private-media.json
```

Em uma execução local, JPEG procedural 1920×1080 de 1.569.686 bytes, dez leituras
somaram 15.696.860 bytes em ambos os modos. Pico de alocação Python medido por
`tracemalloc`: 20.978.036 bytes com leitura integral e 138.396 bytes por streaming.
Resultado em `docs/evidence/private-media-streaming-v11.json`. É filesystem local
sequencial, sem medir R2 real, RSS total, concorrência Cloud Run ou rede celular.

## Evidência executada

```bash
uv run --frozen pytest -q tests/test_private_media_streaming.py \
  tests/test_cloud_run_security.py tests/test_foundation_storage.py \
  tests/test_foundation_security.py tests/test_bridge.py tests/test_pyto_keychain.py
node --test infra/cloudflare/cloud-run-proxy/worker.test.mjs
uv run --frozen mypy apps/api/src/photointel/auth.py \
  apps/api/src/photointel/storage.py apps/api/src/photointel/services/media_http.py \
  apps/api/src/photointel/routers/bridge.py apps/api/src/photointel/routers/catalog.py
```

Rodada localizada de 19/10/2026: **120 testes + 24 subtests Python**, **3 testes
Node** e Mypy sem erro nos cinco módulos. Foi executado também
`tests/integration/test_bridge_protocol.py` contra PostgreSQL local com migrações
v1.1: **1 cenário completo passou**. Esse cenário usa inventário e recibos
sintéticos, matrícula real no protocolo, correspondência ambígua bloqueada,
pausa de escrita preservando operação aprovada, retomada, conflito, read-back
simulado e revogação do Bearer. Não executa PhotoKit.

A suíte inclui assinaturas reais com chave de teste,
issuer/audience/expiração errados, token ausente, email forjado, headers proxy,
origem cross-site, audiência de serviço incompatível, mídia sem autenticação,
stream truncado/desconexão, revisão/304, ranges, tamanho total do objeto diferente
da revisão armazenada e recusa de escrita nativa falsa. Escritas em endpoints
privados pela origem direta também recusam um simples header de email forjado.
Não equivale a revogação remota, autenticação na conta ou CUDA real.

## Segredos e dependências

Gitleaks **8.30.1** foi obtido da release oficial com verificação do SHA-256 do
arquivo publicado. O histórico disponível tinha **43 commits**, aproximadamente
**5,55 MB**. A varredura inicial identificou quatro ocorrências de um identificador
público OAuth/widget Apple no SDK vendorizado e uma fixture sintética histórica
de teste de redação de logs. A inspeção confirmou que não eram credenciais do
operador. `.gitleaks.toml` mantém regras padrão e libera somente a combinação
**arquivo e valor exato** dessas constantes. Não libera pastas inteiras, cookies,
Client Secrets ou novos valores. A repetição no histórico e no snapshot de fonte
retornou **zero achados**. A história compartilhada não foi reescrita.

Com Gitleaks instalado e seu checksum validado, repita:

```bash
python3 infra/scripts/scan-source-secrets.py --output var/security
```

O script verifica o histórico e os arquivos versionados/novos elegíveis a
versionamento. Arquivos ignorados como `.env`, credenciais WIF, backups e `var/`
ficam fora; não é uma auditoria desses arquivos privados. Os relatórios ocultam
valores e recebem permissão `0600`. Um resultado limpo não garante ausência de
segredos fora do histórico local acessível nem substitui rotação após incidente.

`npm --prefix apps/web audit --json` retornou **zero vulnerabilidades conhecidas**
entre **431 dependências** resolvidas. `pip-audit` sobre o ambiente instalado
retornou zero vulnerabilidades conhecidas entre 90 pacotes listados, com dois
pacotes locais sem consulta de advisory. A exportação de runtime + ingestão do
lockfile também foi auditada com resultado limpo:

```bash
uv export --frozen --no-dev --group ingest --no-emit-project \
  --no-emit-package photointel-icloudpd-source > var/runtime-requirements.txt
uvx pip-audit -r var/runtime-requirements.txt --disable-pip
```

Excluir o wheel local dessa exportação evita o erro de requisito local sem hash;
suas dependências transitivas continuam incluídas. Ambos os workflows de CI foram
corrigidos para esse formato. Os arquivos locais vendorizados têm proveniência,
licença e hashes registrados separadamente.

A auditoria adicional do grupo GPU do lockfile, sem invocar Modal, encontrou
**nove entradas de advisory** em `transformers==4.57.6`, algumas duplicadas entre
fontes. Entre elas estavam CVE-2026-4372, CVE-2026-5241 e CVE-2026-9856. O código
foi migrado para **Transformers 5.10.2 / Hub 1.33.0**, incluindo o pin da imagem
Modal e a leitura correta de `pooler_output`. A auditoria do lock GPU atualizado
retornou **zero vulnerabilidades conhecidas**. A versão 5.10.0 foi evitada por
ter sido retirada pelo mantenedor.

A migração 0007 cria IDs distintos de modelo por preprocessing e preserva
embeddings existentes. O protocolo exige namespace explícito: nem um serviço
antigo nem um cliente antigo podem ser aceitos silenciosamente pelo novo runtime.
O teste PostgreSQL verifica preservação do vetor legado, recusa de sua utilização
em busca nova e recusa de downgrade destrutivo. O procedimento com pausa de
workers antigos está em `docs/operations/gpu-runtime-upgrade-v11.md`.

O smoke de pesos reais com **Transformers 5.10.2** terminou em CPU: uma imagem
procedural, **5.813 probabilidades JoyTag**, embeddings SigLIP 2 de **768 dimensões**
e persistência confirmada em nova sessão PostgreSQL. A execução levou 584,48 s
no executor local, incluindo preparação/cache; não é latência estável de produção.
A [evidência atualizada](../evidence/real-cpu-v11.json) preserva hash e mtime do
artefato original, cujo SHA Git não foi registrado. O campo histórico
`gpu_runtime_ms` nessa resposta não significa que houve GPU: `device=cpu` e
`provider_gpu_allocated=false`. O relatório CPU anterior de Transformers 4.57.6
não valida esta atualização.

Não se presume que `trust_remote_code=False` sozinho elimine todo risco. A imagem
efetivamente implantada, seu digest e inferência GPU real continuam exigindo
configuração e smoke test separado. Não houve deploy Modal.
Vulnerabilidades conhecidas e bases de advisories mudam; repetir antes do release.

O workflow Google usa Workload Identity Federation, permissão `id-token: write`
somente no job de deploy, seleção manual, branch `main`, ambiente `production` e
confirmação explícita de projeto/cobrança. Arquivos temporários `gha-creds-*.json`
ficam excluídos de Git e do contexto Docker. A revisão do YAML não comprova a
política IAM/atributos do provider configurado na conta; isso permanece pendente.

## Apple e aceitação física pendentes

O adaptador Pyto permanece read-only para keywords. APIs atuais documentadas
indicam iOS 27.0; a investigação e o protocolo de uma única foto estão em
`PYTO_BRIDGE.md`. O probe apenas observa símbolos públicos, sempre mantém
`native_write_verified=false`. Não modifica o usuário nem inventa sucesso.

A lista em `docs/operations/iphone-acceptance.md` precisa ser executada em Safari
normal e PWA instalada, Wi-Fi/celular, login/expiração Access, Keychain e PhotoKit
reais. Até essa evidência existir, a escrita de keywords e o aceite físico são
**não verificados**. R2 privado exige conferir bucket/domain/política na conta;
ter credenciais para `head_bucket` comprova conectividade, não ausência de uma
configuração pública feita fora do aplicativo.
