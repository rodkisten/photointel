# PhotoIntel PWA, branding e iOS

> **Nota de revisão arquitetural (04/11/2026):** O Worker unificado serve a SPA e seus assets de release. Service worker faz precache de shell e estáticos, **não de imagens privadas e `/v1`**, e deve lidar com atualizações de build sem deixar HTML antigo mascarar JS. Confira [a referência de código e fluxos](../../docs/architecture/FRONTENDS_AND_BRIDGE.md).

O frontend instala um service worker no ambiente de produção. Ele armazena o documento
`/index.html` e **todos os assets públicos do build** (JS, CSS, SVG, PNG, fontes,
manifesto, telas de abertura). Cada build injeta sua lista e fingerprint no `sw.js`,
permitindo abrir a interface e navegar entre rotas mesmo sem conexão **após uma
instalação completa enquanto conectado**.

As fotos, vídeos, miniaturas privadas, respostas de `/v1/*`, autenticação,
diagnósticos e informações pessoais **não entram no CacheStorage**. A galeria ainda
precisa da API para carregar dados novos; offline significa a shell navegável, não
uma cópia local automática da biblioteca. Os assets públicos são mantidos entre
releases, mas Safari e outros navegadores podem removê-los por falta de espaço.
A interface mostra o estado offline e bloqueia a atualização manual sem conexão.

O design original combina nuvem, uma fotografia estilizada e pontos de análise.
Arquivos vetoriais: `icon.svg`, `icon-maskable.svg`, `mark.svg`,
`mark-negative.svg`, `mark-black.svg`, `logo-horizontal.svg`.
O script `npm run prebuild` gera PNGs normais, negativos, maskable e
`apple-touch-icon.png` usando apenas Node.js; também gera telas de abertura para
iPhones selecionados. `npm run build` regenera tudo automaticamente.

Para testar: `npm run test:pwa` e `npm run build`; no Safari,
abra o site online e instale na Tela de Início antes de testar em modo avião.
As imagens nativas de abertura do iOS dependem das dimensões exatas do aparelho;
os demais dispositivos recebem o splash HTML responsivo.
