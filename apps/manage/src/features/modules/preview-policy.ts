/** Native Wrangler previews have no production APIs or same-site Manage cookies. */
export function isIsolatedModulePreview(hostname: string): boolean {
  return hostname.endsWith('.workers.dev');
}
