# Limitações e o que exige validação externa

O código implementa contratos e mecanismos locais. Disponibilidade real de
iCloud, PhotoKit, Modal, Cloudflare e Oracle depende de conta, autenticação,
permissões, rede, cotas e hardware. Não se declara uma integração operacional
apenas porque existe cliente, workflow, mock ou configuração.

| Área | Limitação / evidência necessária |
|---|---|
| iCloud | API não oficial pode mudar, expirar sessão e limitar conta; login/2FA e importação finita reais necessários |
| Proteção Avançada de Dados | Incompatível com o fluxo especificado; estar desativada não garante acesso da API |
| Representações | Medium/thumb podem não existir; estado indisponível e limites de bytes devem ser respeitados |
| Originais | O projeto não é backup completo da biblioteca e não apaga/escreve originais |
| Live Photos/RAW/HEIC/vídeo | Conjuntos de recursos e conversões variam; preserve identidade da fonte e registre capacidades/erros |
| Vídeo no worker v1 | Catálogo de metadados; não executa transcodificação nem inferência de quadros de vídeo |
| Keywords Apple | Leitura/escrita por Pyto/PhotoKit depende do runtime/iOS; beta, condicional e não verificada sem hardware |
| Mapeamento Apple | PhotoKit local ID e cloud ID não são intercambiáveis; filename/data sozinhos não autorizam sync |
| Propagação ao iCloud | Apply no dispositivo não comprova confirmação cloud; revisão/leitura posterior necessárias |
| GPU | Revisões de checkpoint, acesso aos modelos, memória e hardware precisam de inferência real |
| Custo | Estimativa do agendador não é teto de cobrança do provedor |
| 176 mil mídias | Objetivo de escala; capacidade/latência só podem ser afirmadas após benchmark registrado |
| Oracle Always Free | Disponibilidade, cotas e preços mudam por região/conta; não há promessa de VM ou 200 GB |
| Cloudflare | Pages/Tunnel/Access/R2 precisam de provisionamento e testes privados reais |
| Backup | Dump não inclui objetos R2 nem originais; restore sintético não valida backup pessoal |
| PWA | Shell pode funcionar offline; conteúdo privado não deve ficar em cache público/sem controle |

Tags sugeridas são probabilísticas, podem conter conteúdo sensível e dependem
do domínio do modelo. Não demonstram identidade de pessoas ou fatos na imagem.
O usuário pode revisar/rejeitar e tags sensíveis ficam ocultas por padrão.
Busca vetorial aproxima similaridade, não igualdade ou completude.

Testes locais usam fixtures sintéticas. Resultados simulados só aparecem no modo
de testes explicitamente configurado; produção não pode usar backend de teste.
Os relatórios de GPU, benchmarks, Apple e deploy devem identificar data,
ambiente, versão, escopo e erros. Ausência de evidência mantém a capacidade
`not_configured`, `unsupported`, `unverified` ou equivalente previsto no schema.
