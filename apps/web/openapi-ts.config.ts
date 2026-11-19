import { defineConfig } from '@hey-api/openapi-ts';

/**
 * Hey API migration target.
 * Keep generated output isolated until all existing openapi-fetch consumers
 * and schema imports have been migrated and tested.
 */
export default defineConfig({
  input: '../../packages/contracts/openapi.json',
  output: 'src/api/hey-api',
  plugins: [
    '@hey-api/typescript',
    '@hey-api/sdk',
    '@hey-api/client-fetch',
  ],
});
