/** URL contract: main at /, PR previews at /<number>/<any route>. */
const match = /^\/(\d{1,10})(?=\/|$)/.exec(globalThis.location?.pathname ?? '/');
export const manageBasePath = match ? '/' + match[1] : '';
export const managePath = (path: string) => manageBasePath + (path.startsWith('/') ? path : '/' + path);
