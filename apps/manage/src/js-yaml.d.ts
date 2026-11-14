declare module 'js-yaml' {
  export function load(input: string, options?: { json?: boolean }): unknown;
}
