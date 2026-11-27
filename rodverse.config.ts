export const workspace = {
  apps: {
    web: { root: 'apps/web', provider: 'cloudflare', artifact: 'dist', dependencies: ['contracts', 'env'] },
    manage: { root: 'apps/manage', provider: 'cloudflare', artifact: 'dist', dependencies: ['contracts', 'env'] },
  },
  sharedPaths: /^(?:package(?:-lock)?\.json$|\.prettier(?:rc\.json|ignore)$|packages\/|infra\/|scripts\/ci\/|rodverse\.config\.ts$|\.github\/)/,
} as const;
export type App = keyof typeof workspace.apps;
