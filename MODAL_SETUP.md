# Modal, JoyTag e SigLIP 2

## Estado verificável

Existem adaptadores reais PyTorch para JoyTag e SigLIP 2, protocolo HTTP validado,
aplicação Modal implantável e persistência transacional PostgreSQL. Instalar ou
executar testes comuns não baixa checkpoints nem inicia uma GPU. Sem credenciais
Modal e execução explícita, inferência real permanece **não validada neste ambiente**.

JoyTag usa a arquitetura oficial, vocabulário `top_tags.txt`, sigmoid independente
por tag e o pré-processamento oficial. Nunca é substituído por um classificador
genérico. SigLIP 2 usa `google/siglip2-base-patch16-224`: base/224 reduz memória e
custo e mantém texto multilíngue, incluindo português. As projeções de texto e
imagem são normalizadas e comparadas por cosseno. O adaptador confirma em runtime
as dimensões 768 nos dois encoders; uma variante com dimensão diferente exige
migração do banco. Os dois tipos de embedding sempre usam a mesma revisão.

Referências oficiais para conferir a implantação:

- https://github.com/fpgaminer/joytag
- https://huggingface.co/fancyfeast/joytag
- https://huggingface.co/google/siglip2-base-patch16-224
- https://huggingface.co/docs/transformers/model_doc/siglip2
- https://modal.com/docs/reference/modal.asgi_app

O código JoyTag foi incorporado no commit indicado em `gpu/models/NOTICE.md`, com
licença Apache 2.0. Revisions dos **pesos** são configurações independentes: nunca
use `main`, tags móveis nem o SHA do repositório GitHub no lugar do SHA Hugging Face.

## Implantação pelo Codespaces no iPhone

1. Crie uma conta Modal e examine preços/limites no dashboard. O estimador local
   não é um teto garantido de faturamento. Configure controles do provedor.
2. No terminal do Codespaces, execute `uv sync --group gpu` e
   `uv run --group gpu modal token new`. Essa autenticação é administrativa;
   não copie suas credenciais administrativas para a PWA.
3. Confira os SHAs imutáveis nos model cards/configuração versionada do projeto.
   O aplicativo rejeita referências que não sejam um commit SHA hexadecimal de
   40 caracteres.

   Para resolver e verificar somente metadados públicos (não baixa pesos nem
   inicia GPU), execute `uv run python -m gpu.checkpoints`. O relatório inclui
   licença declarada, SHA imutável, dimensão, tamanho/hash do vocabulário e config.
4. No dashboard Modal, crie o Secret `photo-intelligence-inference` com
   `JOYTAG_MODEL_REVISION`, `SIGLIP_MODEL_REVISION` e
   `INFERENCE_SERVICE_TOKEN` aleatório, com pelo menos 32 caracteres.
5. Execute `uv run --group gpu modal deploy gpu/modal_app.py`. Implantar não é um
   teste de inferência; não marque a integração como operacional até o smoke test.
6. Crie uma **Proxy Auth Token** Modal de escopo adequado ao endpoint. A função
   usa `requires_proxy_auth=True`: requisições sem `Modal-Key` e `Modal-Secret`
   são barradas na borda, antes de alocar GPU. O bearer interno é uma segunda
   verificação independente.
7. Configure apenas no backend: `MODAL_ENDPOINT` com a URL HTTPS impressa no
   deploy, `MODAL_TOKEN` com o mesmo `INFERENCE_SERVICE_TOKEN`,
   `MODAL_PROXY_KEY`, `MODAL_PROXY_SECRET`, ambas as revisões e
   `INFERENCE_BACKEND=modal`.
8. Revise `GPU_MAX_ASSETS_PER_RUN`, `GPU_MAX_COST_PER_RUN`, `GPU_DAILY_BUDGET`,
   `GPU_MONTHLY_BUDGET`, `MAX_GPU_CONCURRENCY` e `BATCH_SIZE`. Só então habilite
   `GPU_ENABLED=true` e reinicie backend/worker.

O endpoint não recebe PostgreSQL ou credenciais R2. O backend lê representações
privadas e envia somente pequenos inputs de inferência, autenticados e limitados.
A PWA nunca transmite imagens diretamente ao Modal e nunca recebe esses segredos.
Lotes aceitam no máximo 32 imagens/40 MiB de JSON; cada imagem tem limite de 5 MiB
e 24 milhões de pixels. A implantação usa uma T4, até um container, sem mínimo,
um input concorrente e cache persistente `/models`.

## Teste real explícito

Ingerir primeiro uma imagem sintética gera seu UUID. Em seguida:

```bash
uv run --group gpu python -m gpu.smoke --asset-id UUID_DA_IMAGEM
```

Esse comando **pode consumir créditos**. Ele executa ambos os modelos, valida
probabilidades, dimensão, normalização e similaridade finita, e grava resultados
no PostgreSQL. Uma execução repetida da mesma revisão reutiliza resultados.
Uma mudança de revisão exige nova indexação; vetores incompatíveis não se misturam.

Para um experimento CPU real limitado, instale o grupo GPU e configure
`INFERENCE_BACKEND=cpu`. Os mesmos checkpoints são usados, sem resultados
fabricados. A RAM e o tempo de processamento ainda precisam ser medidos no host;
não é a configuração recomendada no ARM Always Free.

## Orçamentos e recuperação

O banco coordena slots com advisory locks e reserva custos em transações separadas
**antes** da chamada. Para Modal, reserva a estimativa de até três tentativas de
transporte. Reservas não são devolvidas automaticamente após resultado incerto;
isso evita que um timeout permita gasto repetido sem registro. Busca semântica por
texto também exige inferência real e orçamento. Os valores são estimativas: cold
starts, download de pesos, duração real, preços e billing do provedor podem diferir.

Erros transitórios têm retries limitados; o job durável mantém o estado e decide a
próxima tentativa. Não existe fallback de produção para classificação fictícia.
`INFERENCE_BACKEND=test` só é aceito com `APP_ENV=test`; ele existe exclusivamente
para testes determinísticos e deve ser distinguido de inferência real.

O container aquecido guarda no máximo oito respostas de lote e 128 embeddings de
texto na RAM, usando hashes como chaves e sem reter os bytes das imagens/consultas.
Isso reduz inferência repetida em retries após respostas de rede incertas. Reinício
do container invalida esse cache; não há garantia de execução exatamente uma vez
no provedor externo. O banco impede a duplicação dos resultados persistidos.

Todas as probabilidades JoyTag, inclusive abaixo do limiar, permanecem no
`inference_runs.raw_predictions`, por foto, revisão de input e checkpoint, até
expurgo explícito do operador. Assim limiares podem ser reaplicados sem pagar nova
inferência. Tags aprovadas/rejeitadas pelo usuário são preservadas em registros
independentes. Não há expurgo automático desses resultados.

## Rotação e diagnóstico

Desabilite GPU antes da rotação. Crie novos tokens no dashboard, atualize o Secret
Modal e o ambiente do backend, implante, execute um único smoke test e revogue os
tokens anteriores. Nunca coloque tokens em argumentos de processos, arquivos
versionados, logs ou GitHub Actions de pull requests. Não registre imagens,
consultas sensíveis ou o corpo de respostas de inferência.

Falhas de modelo/configuração não devem ser confundidas com tags vazias. Confira
os estados `GPU_UNAVAILABLE`, `MODEL_LOAD_FAILED` e `INFERENCE_FAILED`, a revisão
do registry, a compatibilidade do cache e os limites de memória. Se necessário,
reduza `BATCH_SIZE`; o limite do endpoint e o limite local são independentes.
