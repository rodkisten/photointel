/** Safari/resource errors are classified without leaking sensitive resource URLs. */
export function classifyBrowserError(event: Event): Error | null {
  const target = event.target;
  if (target instanceof HTMLLinkElement) {
    // Optional remote typography may be blocked offline or by Safari privacy
    // settings. It already has a system-font fallback and is not an app crash.
    if (target.rel === 'stylesheet' && target.href.startsWith(
      'https://fonts.googleapis.com/'
    )) return null;
    const error = new Error('Falha no CSS essencial do aplicativo');
    error.name = 'ApplicationStylesheetLoadError';
    return error;
  }
  if (target instanceof HTMLScriptElement) {
    const error = new Error('Falha ao carregar script do aplicativo');
    error.name = 'ApplicationScriptLoadError';
    return error;
  }
  if (target !== window) return null;
  if (event instanceof ErrorEvent && event.error instanceof Error) {
    return event.error;
  }
  const error = new Error('Erro opaco do navegador sem exceção acessível');
  error.name = 'OpaqueBrowserRuntimeError';
  return error;
}

