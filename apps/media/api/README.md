# Independent Media API (staged)

The Media API authenticates clients with a bearer credential whose SHA-256 hash is stored in `MEDIA_TENANTS_JSON`, then authorizes an R2 key under `originals/tenants/<tenant-id>/`. It calls the private gateway to mint a short-lived signed origin URL.

`POST /v1/source/sign` accepts `{"key":"originals/tenants/<tenant-id>/file.jpg"}`.

Runtime secrets:
- `MEDIA_TENANTS_JSON`: JSON array of `{"id":"client-a","tokenHash":"<sha256 hex>","sourcePrefix":"originals/tenants/client-a/"}`. Supply via Secret Manager, never commit real credentials.
- `MEDIA_SOURCE_TOKEN`: dedicated private gateway issuer credential, at least 32 characters.
- `MEDIA_SOURCE_GATEWAY_URL`: HTTPS origin of the staged gateway, with trailing slash.

This is an initial authorization boundary, **not** a production-ready Media API: persistent credential lifecycle, rate limits, request quotas, audit logs, image transformation orchestration, private network policies, and SSRF egress controls remain to be implemented. Do not expose or deploy until those controls and integration tests are complete. Avoid logging the signed source URL, as it is a short-lived bearer capability.
