# PhotoIntel | Cache estático agressivo e app shell offline

Os dois frontends (Photos e Manage) distribuem assets compilados pelo Worker,
com precache automático e versionado pelo SHA-256 dos arquivos de `dist`.
**Nenhum recurso pago, Cache Reserve ou alteração de billing é necessário.**

## Políticas HTTP

| Categoria | Photos | Manage |
| --- | --- | --- |
| JS/CSS/fontes/imagens com hash em `/assets/` | `public, max-age=31536000, immutable` | `private, max-age=31536000, immutable` |
| Imagens/fontes públicas sem hash | 7 dias, `stale-while-revalidate=86400` | 7 dias, somente navegador |
| HTML, navegações, `sw.js`, manifesto e config | `no-store` | `private, no-store` |
| API, autenticação, webhooks, diagnósticos, conteúdo privado | `private, no-store`, não interceptado pelo SW | nunca cacheado |

O Manage é protegido por Cloudflare Access. Nenhuma resposta da interface Manage
é compartilhada pelo CDN: `CDN-Cache-Control: no-store`. Mesmo os bundles
imutáveis são guardados apenas no dispositivo do usuário autenticado.
O Photos só compartilha assets públicos de build. Não habilitar cache de
`/v1/*`, `/api/*`, fotos originais, miniaturas privadas, JWTs ou headers
de autenticação.

## Offline-first para assets públicos

- `apps/web/public/sw.js`: mantém o SW existente com FCM, salvando HTML de
  bootstrap e todos os assets públicos no install.
- `apps/manage/public/sw.js`: precache do mesmo tipo, sem acesso ou
  armazenamento de respostas administrativas; nunca cacheia tela de login do Access.
- `apps/*/scripts/inject-precache.mjs`: gera o manifesto de assets no
  `postbuild` e versiona pelo conteúdo. Instalação incompleta é rejeitada,
  preservando a versão ativa anterior.
- Navegação em ambas as SPAs consulta a rede primeiro; quando indisponível,
  abre o HTML de bootstrap armazenado (rotas internas incluídas).
- Assets de release já salvos são cache-first. Retemos no máximo duas
  versões anteriores dos bundles para abas antigas; navegadores podem
  descartar dados ao liberar espaço.

**Limitação proposital:** o shell, menus, estilos e roteamento são offline;
a galeria e a administração dependem das APIs para conteúdo atualizado.
Acesso local a dados anteriormente carregados não é garantido, e ações que
dependem de servidor não podem ser executadas sem rede.

## Verificação

```bash
npm --prefix apps/web run test:pwa
node --test infra/cloudflare/cloud-run-proxy/worker.test.mjs
npm --prefix apps/manage run test:pwa
npm --prefix apps/manage run test
npm --prefix apps/web run build
npm --prefix apps/manage run build
```

Depois do deploy autenticado: visite cada app **online**, aguarde a instalação
do SW, abra DevTools > Application > Cache Storage, confirme o shell e os bundles
em cache; desconecte a rede e recarregue uma rota interna. O navegador pode
reter um SW antigo até fechar todas as abas ou atualizar a instalação.

Em produção, os Workers Builds exigem um build token válido. Um commit
no GitHub não comprova que a nova versão já chegou ao Worker; confira o
resultado do build/deploy e o conteúdo de `/sw.js` antes do aceite.

### Proibição de cobrança

Não mudar planos, billing, pagamento, Cache Reserve, planos pagos,
regras de cache contratadas ou produtos com cobranças habilitadas.
Esta implementação só usa headers HTTP, Workers Static Assets e
CacheStorage do navegador já disponíveis.
