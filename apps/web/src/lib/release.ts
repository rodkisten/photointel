/** Build metadata is public and contains no credentials. */
export const FRONTEND_RELEASE_ID = typeof import.meta.env.VITE_RELEASE_ID === 'string'
  && /^[0-9a-f]{40}$/.test(import.meta.env.VITE_RELEASE_ID)
  ? import.meta.env.VITE_RELEASE_ID : null;
