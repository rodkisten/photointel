# Media Gateway

Cloudflare Worker for **private, pre-rendered derivatives** stored in the existing
`photointel` R2 bucket. This is not an arbitrary URL-fetching image proxy.

Paths: `GET /v1/media/derived/<key>.<avif|webp|jpeg|png|mp4>?exp=<unix>&sig=<hex-hmac>`

The signature is lowercase hex HMAC-SHA256 over
`GET\\n<complete R2 object key>\\n<expiration unix seconds>`.

Only derived objects can be served. Expiration must be within one hour.
No request URL or user-controlled remote origin is fetched. Worker accesses R2
using its native binding. Secrets must be configured using Wrangler secret
management, never in `wrangler.jsonc`.

```sh
cd services/media/gateway
npm install
npm run typecheck
npx wrangler dev
```

Do not deploy before integration tests, signature issuance, tenant authorization,
and cost/security review. This Worker serves precomputed results only; Imagor
and FFmpeg ingestion/job dispatch remain separate production gates.
