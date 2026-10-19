/** Diagnostics can link only to this application, never to another origin. */
export function localPath(value: string | undefined): string | null {
  return value && /^\/(?!\/)[a-z0-9/?=&._%-]*$/i.test(value) ? value : null;
}
