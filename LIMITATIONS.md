# Limitações e pré-requisitos externos v1.1

> **Nota de revisão arquitetural (04/11/2026):** A classificação de estado distingue módulo implementado, integração configurável e **execução real comprovada**. Nenhuma das ferramentas de diagnóstico, fixtures, testes locais ou CI comprova por si só Apple, GPU, FCM no iPhone, capacidade Neon ou Cloudflare em produção. Veja [implementação e fluxogramas](docs/architecture/IMPLEMENTATION_REFERENCE.md).

O código implementa contratos e mecanismos locais. Disponibilidade real de
iCloud, PhotoKit, Modal, Google Cloud, Neon, Cloudflare e Oracle depende de conta, autenticação,
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
| Keywords Apple | Inventário PhotoKit read-only preservado; keywords_read/write permanecem indisponíveis no adapter atual até validar APIs/runtime no hardware. O protocolo não constitui um writer nativo verificado |
| Mapeamento Apple | PhotoKit local ID e cloud ID não são intercambiáveis; filename/data sozinhos não autorizam sync |
| Propagação ao iCloud | Apply no dispositivo não comprova confirmação cloud; revisão/leitura posterior necessárias |
| GPU | Pesos reais JoyTag/SigLIP 2 já têm evidência CPU v1; isso não valida a release v1.1 em Modal/CUDA. Gate real exige deploy, resultado persistido, busca PT e custo medido |
| Custo | Estimativa do agendador não é teto de cobrança do provedor |
| 176 mil mídias | Dataset sintético mede catálogo, tags, vetores e índices; não equivale à biblioteca pessoal nem mede throttling Apple, egress ou latência Neon/Cloud Run reais |
| Neon Free | Cap do catálogo e perfil limitado não garantem enquadramento no Free; HNSW, 768D, tags e raw predictions exigem capacidade medida e possível upgrade |
| Cloud Run | Manifests/CLI/testes locais não são deploy real. API escala a zero; filesystem é efêmero e Jobs precisam respeitar duração, quota e IAM |
| run.app | Origin publicamente alcançável, protegido pela validação JWT da aplicação; não é network-private. Smoke anônimo e teste autenticado real são necessários |
| Oracle Always Free | Disponibilidade, cotas e preços mudam por região/conta; não há promessa de VM ou 200 GB |
| Cloudflare | Pages/Worker/Access/R2 e previews/default pages.dev exigem políticas e testes reais. Tunnel permanece opção VPS; Bridge service-auth é validada separadamente do login browser |
| Backup | Formato v2 inclui bytes privados criptografados e teste local de banco/objetos; modo legado salva só banco. Restore Neon/R2 real e segunda cópia durável dependem do operador; originais iCloud não estão incluídos |
| Sessão Apple | Reidratação AES-GCM, lease e CAS foram testados localmente, mas cookies reais/refresh/login inicial exigem conta/2FA. Revogar pointer não revoga a sessão nos servidores Apple |
| PWA / Safari físico | WebKit Linux e viewport móvel não equivalem ao iPhone. Login/expiração Access, PWA instalada, Wi-Fi/celular, teclado/safe areas e mídia privada exigem teste no aparelho |
| Gastos | Nenhum recurso pago é criado por testes/setup. Aplicar GCP exige autorização explícita; estimativas/alertas e caps locais não são garantia de teto do provedor |
| Gate de produção | Deploy não libera biblioteca inteira. Apple real, Modal real, 100/1.000 fotos, restauração, segurança e capacidade precisam de evidência da mesma release |

Tags sugeridas são probabilísticas, podem conter conteúdo sensível e dependem
do domínio do modelo. Não demonstram identidade de pessoas ou fatos na imagem.
O usuário pode revisar/rejeitar e tags sensíveis ficam ocultas por padrão.
Busca vetorial aproxima similaridade, não igualdade ou completude.

Testes locais usam fixtures sintéticas. Resultados simulados só aparecem no modo
de testes explicitamente configurado; produção não pode usar backend de teste.
Os relatórios de GPU, benchmarks, Apple e deploy devem identificar data,
ambiente, versão, escopo e erros. Ausência de evidência mantém a capacidade
`not_configured`, `unsupported`, `unverified` ou equivalente previsto no schema.

## Estado verificável e expansão

O perfil de produção preparado é Pages/Access + Cloud Run Service/Jobs/Scheduler +
Neon + R2 + Modal; [CLOUD_RUN_SETUP.md](CLOUD_RUN_SETUP.md) separa planos offline,
contas, credenciais, cobrança autorizada e smoke real. Oracle/Compose permanece
fallback e desenvolvimento. [ICLOUD_SESSION_SETUP.md](ICLOUD_SESSION_SETUP.md) e
[DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) documentam as fronteiras de cookies
e cópias privadas. As migrações expandem o schema existente; não há reset do banco.

Uma aprovação manual de evidência em uma gate é uma atestação do operador,
não uma verificação independente das contas externas. Evidência histórica v1 é
preservada e identificada como tal; consulte [VALIDATION.md](VALIDATION.md) para
a revisão e comandos efetivamente executados na v1.1. Nenhum status deve ser
promovido para produção plenamente validada enquanto faltarem testes reais.
