// Reviewed Sandbox artifact origin only; PR remotes never enter the privileged host.
const sandbox = 'https://sandbox.migos.club';
export function moduleContentSecurityPolicy(production: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${sandbox}/modules/sandbox/`,
    `worker-src 'self' blob: ${sandbox}/modules/sandbox/`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${sandbox} https://cdn.jsdelivr.net${production ? ' https://*.sentry.io' : ''}`,
    `frame-src ${sandbox}/modules/sandbox/`,
    "img-src 'self' data:",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
