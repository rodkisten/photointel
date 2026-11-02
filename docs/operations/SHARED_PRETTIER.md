# Prettier compartilhado: PhotoIntel Web, Manage e Workers

A configuração reside **apenas na raiz** do repositório: `.prettierrc.json`,
`.prettierignore` e `package.json`. Os dois frontends usam a **mesma versão
fixa, Prettier 3.6.2**, sem instalações nem configurações divergentes.

## Instalação e uso

Na raiz do repositório:

```bash
npm ci
npm run format             # Ambos os frontends + os Workers JavaScript/TypeScript + CSS e HTML
npm run format:check       # Somente verifica, sem modificar arquivos
npm run format:web         # apps/web + infra/cloudflare/cloud-run-proxy
npm run format:manage      # apps/manage
```

Dentro de cada frontend (depois de executar `npm ci` na raiz):

```bash
npm run format
npm run format:check
```

A primeira formatação de todos os arquivos existentes foi aplicada em
`feat/shared-prettier-frontends` e validada com `format:check`.

### Escopo

- `apps/web`: TS/TSX, JS, CSS, HTML, JSON e arquivos Vite.
- `apps/manage`: TS/TSX, Worker `src/worker.ts`, CSS, HTML, JSON e config Wrangler.
- `infra/cloudflare/cloud-run-proxy`: JavaScript e testes do Worker.

Lockfiles, arquivos gerados, bibliotecas instaladas, bundles de produção,
imagens e contratos gerados são ignorados.

A configuração utiliza aspas simples em JS/TS, aspas padrão em JSX, indentação
de 2 espaços, `printWidth: 110`, ponto e vírgula, vírgulas finais e LF.
**Prettier formata; ESLint e TypeScript continuam responsáveis pela qualidade
semântica do código.**

### CI

As validações de `deploy-worker.yml` e `manage-validation.yml` executam a
checagem de formatação específica do frontend. O workflow de deploy do Manage
também verifica o formato antes de publicar; uma alteração de estilo fora do
padrão bloqueia o build, sem reformatar nem modificar a branch em produção.

O PR que contém a primeira formatação deve ser revisado como alteração
**exclusivamente de estilo** e aprovado somente se lint, testes e build passarem.
