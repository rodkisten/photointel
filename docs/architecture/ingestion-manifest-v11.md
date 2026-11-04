# Ingestão recuperável v1.1

> **Nota de revisão arquitetural (04/11/2026):** A descoberta incremental/backfill permanece autorizada, finita e baseada em manifestos cifrados; a documentação consolidada inclui **reparo automático catalog+R2**, reobtenção da fonte e watchdog horário, mantendo este documento como descrição das invariantes v1.1. Veja [arquitetura e evidências](INGESTION_AND_RECOVERY.md).

A integração continua usando o SDK oficial do projeto `icloudpd` na revisão
registrada em `packages/icloudpd-source/UPSTREAM.json`. A distribuição binária PyPI
não disponibiliza todos os módulos Python utilizados pelo adapter; o código MIT
necessário está preservado no pacote local. Isso não transforma a interface Apple
não oficial em uma API estável ou homologada.

## Autorização e limites

`authorize_import` produz uma autorização explícita contendo o limite inicial,
o máximo autorizado pelo operador, o limite absoluto, a confirmação de expansão
e `requested_batch_limit`. A API persiste essa decisão em `jobs.payload` antes de
qualquer operação externa. O runner compara o limite recebido com essa decisão;
configuração incompatível gera erro, sem reduzir silenciosamente uma autorização.

A descoberta registra `discovery_progress` no próprio job, na mesma transação
que grava cada manifesto e avança o cursor. Uma nova execução do mesmo job após
37 itens de um limite de 100 admite somente os 63 restantes. Uma nova solicitação
independente tem sua própria autorização. A presença de um cursor nunca autoriza
uma importação ilimitada.

Cada representação reserva uma vez seus bytes previstos no orçamento persistido.
O row lock do lote protege os contadores; cada job finito tem um orçamento próprio,
e o lote mantém o agregado. A recusa deixa o ativo em quarentena com o código
`DOWNLOAD_BUDGET_EXCEEDED`, tamanho previsto e limite. Não há fallback para um
original maior. Uma estimativa não é uma garantia de teto de cobrança do provedor.

O limite do catálogo usa um contador persistido em `settings`, protegido por row
lock. A admissão e o INSERT do ativo pertencem à mesma transação: concorrentes não
podem ultrapassar a capacidade autorizada. A descoberta e a importação de fixtures
reconciliam esse contador com um único `COUNT` no início de cada execução finita;
não há uma contagem de todo o catálogo para cada nova foto. Upserts idempotentes
não consomem novas posições. SQL administrativo fora da aplicação deve ser seguido
por essa reconciliação antes de novas admissões.

## Descoberta, backfill e reconciliação

O SDK fixado usa `startRank`, um offset sujeito a inserções e remoções. Ele não
fornece o cursor CloudKit estável que algumas implementações presumiam existir.
O serviço persiste o offset **como otimização**, junto com os últimos 32 IDs de
origem. Antes de retomar, busca e compara esses anchors. Se a posição mudou,
reinicia somente a descoberta e reutiliza o manifesto idempotente; não repete
downloads ou inferência concluídos.

- `backfill`: retoma o cursor profundo sem revisitar a cabeça em cada lote.
- `incremental`: verifica a cabeça e termina após a janela configurada de ativos
  conhecidos consecutivos, respeitando o máximo autorizado quando há novos ativos.
- `reconciliation`: mantém um cursor profundo separado. Uma varredura completa
  bem-sucedida pode marcar candidatos a ausente; nunca apaga fotos ou registros.

Após um backfill concluído, a reconciliação profunda é devida semanalmente por
padrão. Uma reconciliação interrompida continua nos próximos agendamentos. O
scheduler somente persiste trabalho; Cloud Scheduler invoca o runner finito.
Inserções retroativas que escapem da cabeça dependem dessa reconciliação, e não
da suposição incorreta de que data de captura equivale à data de adição.

A continuação automática de um backfill exige **outra autorização explícita**:
perfil `full`, capacidade suficiente, `target_assets` e confirmação do operador.
Somente metas novas acima de 1.000 fotos exigem a autorização F da API; uma
sequência já autorizada sobrevive a redeploys sem ampliar a meta original.
Cada continuação tem limite finito, limites correntes de capacidade e bytes e
chave idempotente baseada em scan/cursor. Não há continuação implícita
de um teste de 100, 500 ou 1.000 fotos. Pausa e cancelamento do lote
continuam sendo respeitados pela aquisição da fila PostgreSQL.

## Falhas isoladas e proteção de identidade

A descoberta persiste UUID interno, identidade do downloader, revisão e manifesto
antes de enfileirar `media_download`. O ID do downloader não é tratado como um
`PHCloudIdentifier`. Os recursos de Live Photo são associados ao mesmo UUID quando
os metadados de origem permitem. Vídeos ficam no catálogo sem análise visual v1.

Cada download é um job independente. Um erro na foto 137 não reverte o checkpoint
nem o trabalho das demais fotos. Registros remotos malformados com identidade
conhecida são colocados em quarentena; uma identidade que não possa ser lida não
é inventada. As categorias de falha distinguem rede, autenticação, throttling,
ausência remota, mídia inválida e storage. Retries têm limite e backoff com jitter.

Os registros remotos necessários para reconstruir o `PhotoAsset` contêm URLs
assinadas. Eles são persistidos somente como ciphertext AES-256-GCM com nonce
aleatório e AAD que vincula biblioteca, ID de origem e revisão. A chave fica fora
do PostgreSQL, em Secret Manager na produção. Metadados de diagnóstico permitem
listar falhas sem descriptografar URLs ou expor cookies.

## Transações e recuperação de objetos

As transações PostgreSQL cobrem apenas aquisição, checkpoints e persistência.
Autenticação Apple, iteração HTTP, downloads, hashing, decode e transferências R2
acontecem depois de liberar a conexão. O commit dos resultados verifica lease,
fencing token e revisão. Um worker antigo não pode publicar resultados sobre um
novo proprietário.

A persistência de falhas também verifica ownership. Se um worker perder sua lease
durante uma chamada externa, ele não pode marcar como interrompida a varredura que
já pertence a uma execução mais recente.

A manutenção também encerra tentativas antigas de ingestão com
`WORKER_INTERRUPTED`, em lotes limitados, quando o job proprietário terminou,
perdeu sua lease ou iniciou uma tentativa mais recente. Essa recuperação altera
somente `ingestion_runs`; não modifica o manifesto/cursor compartilhado nem a
tentativa atual. Cada claim atualiza `jobs.started_at`, e os eventos preservam o
histórico de aquisição.

Antes de um upload, `object_intents` registra a chave imutável e o SHA-256. Depois
do upload, uma transação curta publica `asset_resources` com
`resource_type=source_download` e confirma o intent. Se o processo morrer entre
essas etapas, a manutenção pode reconciliar o intent sem apagar objetos
arbitrários do bucket. A representação em storage privado permite recomeçar após
um cold start sem depender de `/tmp`.

A reutilização de `source_download` exige uma leitura privada em streaming e
verificação de tamanho e SHA-256, fora da transação SQL. Um objeto ausente ou
corrompido invalida somente aquele recurso/revisão, mantém o incidente no catálogo
e permite reconstrução pelo cache íntegro ou por outro download. Uma indisponibilidade
temporária do storage não é interpretada como corrupção nem provoca invalidação.

## Cache local

O cache é descartável. Um arquivo só é reutilizado com tamanho esperado,
`manifest_version`, revisão da representação, marcador de conclusão e SHA-256
local verificado. O checksum opaco do iCloud participa da identidade de revisão,
mas não é interpretado como SHA-256. Arquivos de mesmo tamanho e conteúdo diferente
são invalidados. Parciais são retomados somente com binding e digest próprios;
respostas `Content-Range` incompatíveis são recusadas antes de gravar bytes.

A conclusão usa arquivo parcial, `fsync` e substituição atômica. Incidentes de
integridade retêm um histórico local limitado e metadados de diagnóstico, sem
conteúdo de fotos nem URLs assinadas. A remoção desse cache nunca significa
remoção de uma foto no iCloud.

## Evidência e limites da validação

`tests/integration/test_discovery_pipeline_v11.py` usa PostgreSQL real, manifests
criptografados e imagens procedurais. Ele cobre limites 100/500/1.000, falha isolada,
retomada, anchors deslocados, ausência de conexão SQL durante I/O e continuação
controlada. Esses adapters controlados **não** provam autenticação ou throughput
real no iCloud. Testes externos permanecem recomendados, mas não exigem os antigos gates
B-E. A autorização F é necessária somente acima de 1.000 fotos.
