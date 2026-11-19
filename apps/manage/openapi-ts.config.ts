import { defineConfig } from '@hey-api/openapi-ts';

/**
 * Transitional Hey API generation.
 * The existing OpenAPI client remains in use until consumer imports and
 * Cloudflare Access handling are migrated and verified.
 */
export default defineConfig({
  input: '../../packages/contracts/openapi.json',
  output: 'src/api/hey-api',
  plugins: [
    '@hey-api/client-fetch',
    '@hey-api/typescript',
    '@hey-api/sdk',
  ],
});
