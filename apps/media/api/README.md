# Independent Media API (staged)

The Media API authenticates clients with a bearer credential whose SHA-256 hash is stored in `MEDIA_TENANTS_JSON`, then authorizes an R2 key under `originals/tenants/<tenant-id>/`. It calls the private gateway to mint a short-lived signed origin URL.

`POST /v1/source/sign` accepts `{"key":"originals/tenants/<tenant-id>/file.jpg"}`.

Runtime secrets:
- `MEDIA_TENANTS_JSON`: JSON array of `{"id":"client-a","tokenHash":"<sha256 hex>","sourcePrefix":"originals/tenants/client-a/"}`. Supply via Secret Manager, never commit real credentials.
- `MEDIA_SOURCE_TOKEN`: dedicated private gateway issuer credential, at least 32 characters.
- `MEDIA_SOURCE_GATEWAY_URL`: HTTPS origin of the staged gateway, with trailing slash.

This is an initial authorization boundary, **not** a production-ready Media API: persistent credential lifecycle, rate limits, request quotas, audit logs, image transformation orchestration, private network policies, and SSRF egress controls remain to be implemented. Do not expose or deploy until those controls and integration tests are complete. Avoid logging the signed source URL, as it is a short-lived bearer capability.

## Imagor transform URL (staged)

`POST /v1/image/transform` accepts:

```json
{
  "key": "originals/tenants/client-a/photo.jpg",
  "transform": {
    "width": 800,
    "height": 600,
    "fit": "contain",
    "format": "webp",
    "quality": 80
  }
}
```

The API authenticates and authorizes the source, requests a 60-second private source URL from the gateway, and constructs a signed Imagor URL. Dimensions must be 1–4096, total pixels at most 16 million, quality 30–95, format `webp|avif|jpeg|png`, fit `contain|cover`. Unsupported operations are rejected.

Runtime `MEDIA_IMAGOR_URL` must be an HTTPS origin and `MEDIA_IMAGOR_SECRET` must match the Imagor runtime `IMAGOR_SECRET` (at least 32 characters). The runtime is configured for `IMAGOR_SIGNER_TYPE=sha256` with no truncation. The API signs the exact path using HMAC-SHA256 and uses Imagor's `b64:` source syntax and `expire()` filter.

**Not yet ready for production:** The returned URL is usable only while the underlying source signature is valid (at most 60 seconds); Imagor has not yet been deployed or tested against real R2 fixtures. Configure `HTTP_LOADER_ALLOWED_SOURCES` to the **exact gateway host**, enforce outbound network policy, prevent signed URL leakage through access logs, and add quotas/rate limits before exposure. There is no persisted derivative or Sharp cutover yet.
