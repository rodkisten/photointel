# Modelo de custos e limites operacionais

Não há promessa de custo zero. Cotas e preços variam por região, provedor, data e
conta. Nenhum recurso Google pago é criado durante instalação, testes unitários,
benchmarks locais ou build. Publicação requer autorização explícita, projeto com
billing e os comandos documentados em [CLOUD_RUN_SETUP.md](CLOUD_RUN_SETUP.md).

## Componentes que podem gerar cobrança

| Componente | Unidade que deve ser observada |
| --- | --- |
| Cloud Run Service | requisições, vCPU/RAM durante requisição, saída de rede |
| Cloud Run Jobs | vCPU/RAM e duração de cada tarefa, retries e paralelismo |
| Cloud Scheduler | quantidade de agendamentos e execuções |
| Artifact Registry / Cloud Build | armazenamento de imagens, builds e transferência |
| Secret Manager / Logging | versões/acessos de segredos, ingestão/retenção de logs |
| Neon | compute ativo, armazenamento, branches, índices e transferência |
| R2 | bytes persistentes, operações Class A/B, versões e cópia de backup |
| Modal | GPU, CPU/RAM, cold starts, volumes de modelos e transferência |
| Cloudflare Pages / Workers | build, requests e execução do proxy autenticado |

Cloud Run mínimo zero evita uma instância web ociosa permanentemente alocada;
Jobs agendados ainda consomem recursos. Evite NAT, VPC connector, IP estático e
load balancer sem necessidade. Saída Google para R2/Modal é transferência entre
provedores e pode gerar custo, mesmo se o destino não cobrar egress.

## Estimativas reproduzíveis

```text
R2 derivados ≈ fotos × (thumb pequena + thumb média + preview)
R2 temporário ≈ lote simultâneo × tamanho do input de inferência
R2 backup ≈ conteúdo preservado fora do bucket primário × retenção
Neon ≈ tabelas + TOAST + índices + resultados brutos + histórico + margem
Modal ≈ horas medidas de GPU × preço vigente + CPU/RAM/volumes/transferência
Cloud Run Jobs ≈ execuções × tarefas × duração × preços de CPU/RAM da região
```

O dataset de capacidade usa tamanhos sintéticos de 12.000 + 65.000 + 260.000 bytes
por foto para modelar derivados (337.000 bytes por ativo). Isso corresponde a
59,312 GB decimais para 176.000 fotos, **não** a um consumo R2 medido. As imagens
pessoais podem comprimir de maneira muito diferente. O benchmark não cria esses
objetos: armazena apenas os seus metadados sintéticos.

Vetores float32 de 768 dimensões representam 3.072 bytes numéricos por foto antes
do overhead de tipo, TOAST, linhas, índices e histórico. Para 176.000 imagens são
540.672.000 bytes numéricos. HNSW e cerca de 5,28 milhões de associações de tags
adicionam espaço substancial. Resultados JoyTag com as 5.813 probabilidades brutas
podem superar largamente o tamanho dos vetores. O relatório de capacidade mede
uma amostra completa desses resultados e projeta a retenção total separadamente.

Os valores medidos e as limitações estão em
[CAPACITY_REPORT.md](CAPACITY_REPORT.md) e nos JSONs correspondentes.
Nenhum benchmark sintético local mede iCloud, GPU Modal, rede celular ou cobrança
Cloud Run. Esses números só devem ser medidos nos gates reais de 10/100/1.000 fotos.

Na medição sintética inicial de 10.000 fotos, tabelas, índices e amostra de 1% das
probabilidades ocuparam 287,21 MB. A projeção adicional de probabilidades para as
demais fotos foi 952,93 MB, totalizando cerca de 1,24 GB. Essa projeção não é uma
medição da retenção completa. Use o valor como alerta de capacidade e valide os
dados reais antes de contratar ou ampliar o plano; considere também espaço para
reindexação e backups. `halfvec` reduz principalmente o índice vetorial e não
resolve sozinho o volume de associações de tags e probabilidades brutas.

## Controles conservadores

- iCloud e GPU permanecem desativados até configuração e ação explícita.
- Limite inicial: 100 imagens; expansão exige autorização validada e limite hard.
- Perfil limitado de banco: teto explícito de 1.000 ativos por padrão.
- API com mínimo zero, máximo de instâncias e concorrência configuráveis.
- Workers com lote, duração, lease e paralelismo limitados.
- Slots de inferência e reservas diária/mensal persistidos no PostgreSQL.
- Cache textual por checkpoint/preprocessamento, TTL e limite de entradas; hits
  não chamam Modal nem reservam novo orçamento de inferência.
- Limites de bytes por foto/execução e limpeza explícita de objetos temporários.
- Backfill completo exige os gates prévios e aprovação de ampliação.

O estimador da aplicação reserva retries possíveis de forma conservadora. Uma
reserva não é uma fatura, e falhas de transporte podem consumir créditos sem uma
resposta confirmada. Alertas Google/Neon/Modal e limites de aplicação **não são
hard caps de cobrança garantidos pelo provedor**. Configure alertas oficiais e
revise custos por execução antes de ampliar.

## Ajustes antes da biblioteca completa

1. Execute 10 imagens reais e meça bytes transferidos, tamanho dos derivados,
   segundos de GPU, cold start, duração do Job e crescimento do banco.
2. Repita com 100 imagens, incluindo retries e reinício; compare estimativa/fatura.
3. Verifique 1.000 imagens com capacidade disponível e backup restaurado.
4. Escolha plano de banco com folga para resultados brutos e reindexação; reduza
   retenção somente com exportação/arquivamento documentado, sem perda silenciosa.
5. Defina orçamento, concorrência e limite de importação. Revise diariamente no
   início do backfill. Pause pelo painel se atingir o orçamento aprovado.

A avaliação de `halfvec` no benchmark é experimental: mede economia de índice e
overlap/recall em dados sintéticos, sem alterar precisão da produção. Uma consulta
sintética não basta para aprovar uma migração de embeddings reais.
