// Reviewed Sandbox artifact origin only; PR remotes never enter the privileged host.
export const ISOLATED_SANDBOX_ORIGIN = 'https://pr14.sandbox.migos.club';
const sandbox = 'https://sandbox.migos.club';
export function moduleContentSecurityPolicy(production: boolean): string {
  const origins = production ? [sandbox] : [sandbox, ISOLATED_SANDBOX_ORIGIN];
  const artifacts = origins.map((origin) => origin + '/modules/sandbox/').join(' ');
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${artifacts}`,
    `worker-src 'self' blob: ${artifacts}`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${origins.join(' ')} https://cdn.jsdelivr.net${production ? ' https://*.sentry.io' : ''}`,
    `frame-src ${artifacts}`,
    "img-src 'self' data:",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
