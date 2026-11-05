# Firebase Cloud Messaging · notificações de jobs

> **Nota de revisão arquitetural (04/11/2026):** O Firebase do projeto está configurado para **`photointel`**. Registro no browser, armazenamento de instalação e envio FCM HTTP v1 dependem de permissões reais; a presença do SDK no PWA não comprova notificações no iPhone. Confira [a referência de código e fluxos](architecture/OBSERVABILITY_AND_OPERATIONS.md).

O PhotoIntel já usa o mesmo `/sw.js` para PWA offline e FCM. O navegador
registra a instalação com o Firebase SDK 13.1.0 e associa seu Firebase
Installation ID (FID) à identidade autenticada pelo Cloudflare Access.

## Configuração do deploy

Adicione **duas entradas não sigilosas** no `GCP_CONFIG_ENV` (dotenv) do
GitHub Environment `production`:

```dotenv
FCM_PROJECT_ID=photointel
FCM_JOB_EVENTS_ENABLED=true
```

O conversor `infra/gcp/gcp_env.py` coloca as chaves em `extra_environment`.
Elas também podem ser declaradas como `EXTRA_ENVIRONMENT__FCM_PROJECT_ID`
e `EXTRA_ENVIRONMENT__FCM_JOB_EVENTS_ENABLED`, mas não duplique as formas.
O deploy passa ambas às instâncias de API e aos Cloud Run Jobs. Não configure
chaves privadas Firebase nem tokens de servidor no frontend.

**Permissões automáticas (projeto único):** tanto Cloud Run quanto Firebase
Cloud Messaging pertencem ao projeto GCP `photointel`.
Depois de salvar as duas entradas .env acima, execute
**Actions → 🧱 Setup GCP → Run workflow → mode: permissions**
na branch `main`.

O modo `permissions` de `.github/workflows/gcp-bootstrap.yml` executa
`infra/gcp/bootstrap.sh`. Com FCM habilitado, ele:

- Verifica e habilita `fcm.googleapis.com` **uma única vez** no projeto `photointel`;
- Concede `roles/firebasecloudmessaging.admin` somente às service accounts
  `photointel-api@photointel.iam.gserviceaccount.com` e
  `photointel-jobs@photointel.iam.gserviceaccount.com`, no mesmo projeto;
- Mantém o modo idempotente, sem ampliar privilégios do deployer, Manage ou migrador;
- Recusa `FCM_PROJECT_ID` diferente de `project_id`, evitando alterações de
  IAM acidentais em outros projetos.

A identidade do bootstrap
(`photointel-bootstrap@photointel.iam.gserviceaccount.com`) precisa ter
`serviceusage.services.list`, `serviceusage.services.enable`,
`resourcemanager.projects.getIamPolicy` e
`resourcemanager.projects.setIamPolicy` **no próprio projeto `photointel`**.
O workflow diagnostica a falta dessas permissões, mas não consegue conceder a
si próprio direitos administrativos que ainda não possui.

O modo `apply` também reconcilia as permissões. O modo `plan` apenas
descreve as mudanças, sem acessar ou modificar o Firebase.

**Atenção à configuração do navegador:** os arquivos
`apps/web/public/fcm.js` e `apps/web/public/sw.js` ainda contêm a
configuração do Firebase Web App anteriormente fornecida para o projeto
`photointel-firebase`. `apiKey`, `appId`, `messagingSenderId` e a chave
VAPID pertencem àquele aplicativo e **não podem ser transferidos** apenas
mudando `projectId`. Para receber push de `photointel`, substitua **o objeto
completo de configuração nos dois arquivos** pelos valores reais do Firebase
Console → Projeto `photointel` → Configurações → Seus apps → App Web, e use
a chave VAPID correspondente ao mesmo projeto. Não reutilize as credenciais
de `photointel-firebase`. Até essa atualização, o backend corrigido e o
registro web existente não pertencem ao mesmo projeto e os envios poderão falhar.

O servidor usa **Application Default Credentials**, com escopo
`https://www.googleapis.com/auth/firebase.messaging`; não precisa de JSON de
conta de serviço. Erros de IAM e envio são registrados com tipo de exceção,
sem expor token ou payload.

## Ativação no navegador e iPhone

1. Abra `https://photos.migos.club`. Em **Visão geral → Notificações de
   processamento**, toque **Ativar notificações**.
2. No iPhone, adicione o PhotoIntel à **Tela de Início** e abra o ícone
   instalado antes de habilitar (iOS 16.4+). A solicitação de permissão deve
   acontecer a partir do toque; fora de um PWA instalado, o Safari do iPhone
   não oferece esse recurso.
3. Com `FCM_JOB_EVENTS_ENABLED=true`, pressione **Enviar teste**. O servidor
   envia a notificação para os dispositivos registrados de sua identidade.

As chamadas autenticadas são:
- `POST /v1/push/registrations`: salva/renova o FID no PostgreSQL;
- `DELETE /v1/push/registrations`: remove o FID da mesma identidade;
- `GET /v1/push/status`: estado do emissor e contagem de dispositivos;
- `POST /v1/push/test`: teste explícito e autenticado.

O FID não aparece nos logs, em URL ou no toast. Registros com mais de 45 dias
sem renovação deixam de receber push. Identidades removidas da lista permitida
no Cloudflare Access também deixam de ser destinatárias.

## Eventos e experiência

Os eventos são consumidos da tabela `job_events` **após o commit**. Um cursor
com lease mantém entrega independente de Telegram e Notify! Live Activities.
Notificações são agrupadas por lote, ou pelo job quando não há lote, com
`tag` fixa para substituir o alerta anterior. O progresso é enviado em
intervalos de 10%, além das transições de estado, falhas e conclusão; assim
uma importação de milhares de imagens não gera milhares de banners.

O payload contém somente `job_id`, `event_id`, estado, contagens, escopo
e link autenticado para `/jobs`. Nunca inclui fotos, nomes dos arquivos,
detalhes de erro ou credenciais. Em primeiro plano, o frontend recebe
`onMessage`, atualiza os dados dos jobs e mostra um aviso em estados relevantes;
em segundo plano, o service worker exibe a notificação. Tocar no alerta abre
o centro de processamento, preservando a autenticação existente.

A entrega é *best effort*: falhas do FCM não mudam o resultado do job nem
impedem o envio por outros provedores. O painel de jobs e SSE continuam a
fonte de verdade do histórico de cada transição. Se não houver dispositivo
registrado, não há chamadas à API do Firebase.

## Referências

- [Firebase: registro por FID](https://firebase.google.com/docs/cloud-messaging/web/get-started)
- [Firebase: API HTTP v1](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages/send)
- [Apple: Web Push para apps na Tela de Início](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
