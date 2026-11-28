// Only reviewed origins. PR code is available solely on the API-less preview host.
export const ISOLATED_SANDBOX_ORIGIN = 'https://sandbox.migos.club';
export const ISOLATED_CODE_ORIGIN = 'https://pr-29.preview.shell.migos.club';
const sandbox = 'https://sandbox.migos.club';
const code = 'https://shell.migos.club';
export function moduleContentSecurityPolicy(production: boolean): string {
  const origins = [sandbox, code, ...(production ? [] : [ISOLATED_CODE_ORIGIN])];
  const artifacts = [
    sandbox + '/modules/sandbox/',
    code + '/modules/code/',
    ...(production ? [] : [ISOLATED_CODE_ORIGIN + '/modules/code/']),
  ].join(' ');
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${artifacts}`,
    `worker-src 'self' blob: ${artifacts}`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${origins.join(' ')} https://cdn.jsdelivr.net https://api.github.com https://raw.githubusercontent.com${production ? ' https://*.sentry.io' : ''}`,
    `frame-src ${sandbox}/modules/sandbox/`,
    "img-src 'self' data:",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
