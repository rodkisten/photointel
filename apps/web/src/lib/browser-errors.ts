/** Safari/resource errors are classified without leaking sensitive resource URLs. */

// --- CONFIGURATION ---

export const BROWSER_ERROR_CONFIG = {
  // Safe list of non-critical external resources that shouldn't trigger crash reports
  IGNORED_STYLESHEET_PREFIXES: [
    'https://fonts.googleapis.com/',
    // Future CDNs or non-critical assets (e.g., Typekit, analytics) can be added here
  ],
  ELEMENT_TYPES: {
    STYLESHEET: 'stylesheet',
  }
};

export const ERROR_DEFINITIONS = {
  STYLESHEET: {
    name: 'ApplicationStylesheetLoadError',
    message: 'Falha no CSS essencial do aplicativo',
  },
  SCRIPT: {
    name: 'ApplicationScriptLoadError',
    message: 'Falha ao carregar script do aplicativo',
  },
  OPAQUE: {
    name: 'OpaqueBrowserRuntimeError',
    message: 'Erro opaco do navegador sem exceção acessível',
  },
} as const;

// --- UTILITIES ---

// Checks if a failed stylesheet is non-critical and should be silently ignored
function isIgnoredStylesheet(href: string): boolean {
  return BROWSER_ERROR_CONFIG.IGNORED_STYLESHEET_PREFIXES.some(prefix => href.startsWith(prefix));
}

// Standardizes error object creation to ensure consistent naming and messages
function createClassifiedError(type: keyof typeof ERROR_DEFINITIONS): Error {
  const def = ERROR_DEFINITIONS[type];
  const error = new Error(def.message);
  error.name = def.name;
  return error;
}

// --- MAIN CLASSIFICATION FLOW ---

export function classifyBrowserError(event: Event): Error | null {
  const target = event.target;

  // 1. Handle Link Elements (CSS)
  if (target instanceof HTMLLinkElement) {
    // Optional remote resources (like typography) may be blocked offline or by Safari privacy settings.
    // They already have system fallbacks and shouldn't trigger an app crash.
    if (
      target.rel === BROWSER_ERROR_CONFIG.ELEMENT_TYPES.STYLESHEET && 
      isIgnoredStylesheet(target.href)
    ) {
      return null;
    }
    return createClassifiedError('STYLESHEET');
  }

  // 2. Handle Script Elements (JS)
  if (target instanceof HTMLScriptElement) {
    return createClassifiedError('SCRIPT');
  }

  // 3. Ignore DOM element errors that are not explicitly tracked (e.g., images, iframes)
  if (target !== window) {
    return null;
  }

  // 4. Extract rich Error objects from global window ErrorEvents
  if (event instanceof ErrorEvent && event.error instanceof Error) {
    return event.error;
  }

  // 5. Fallback for unreadable errors (e.g., cross-origin script errors without CORS)
  return createClassifiedError('OPAQUE');
}
