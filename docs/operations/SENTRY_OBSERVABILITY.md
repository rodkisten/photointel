# Sentry + Cloud Logging: PhotoIntel end-to-end diagnostics

The same operation has **two identifiers**:
- `correlation_id`: a canonical UUID from the Cloudflare edge, passed through FastAPI and PostgreSQL jobs. Search in Google Cloud Logs Explorer.
- `sentry_event_id`: a 32-character hexadecimal ID for a **specific exception**. Every failing job attempt can have its own event. The app's **Ver erro exato no Sentry** button uses an authenticated resolver and the official Sentry API.

Distributed tracing also transmits `sentry-trace` and `baggage` from the browser through the Cloudflare relay to FastAPI. When work is queued, these propagation values are persisted in the job payload and continued by the finite Cloud Run worker. Historical jobs don't gain IDs retroactively.

## Initial configuration (do not commit credentials)

1. Create an organization and browser/server projects at https://sentry.io. You may reuse a server DSN for the API and worker, with distinct `service` tags.
2. Put **SENTRY_DSN** and **SENTRY_API_TOKEN** into Google Secret Manager. Create pinned `name` and numeric `version` references under `secrets` in `GCP_CONFIG_ENV`. The API token needs `org:read` to resolve events and must **never** appear in browser builds, Worker vars or client JavaScript.
3. Add the *public browser* DSN and nonsecret org/project slugs to `extra_environment` in the same GCP config JSON:

```json
{
  "extra_environment": {
    "VITE_SENTRY_DSN": "https://PUBLIC_KEY@o0.ingest.sentry.io/PROJECT_ID",
    "SENTRY_ORG": "your-sentry-org",
    "SENTRY_PROJECT": "your-frontend-project"
  },
  "secrets": {
    "SENTRY_DSN": {"name": "photointel-sentry-dsn", "version": "1"},
    "SENTRY_API_TOKEN": {"name": "photointel-sentry-api-token", "version": "1"}
  },
  "workflow_secrets": {
    "SENTRY_AUTH_TOKEN": {"name": "photointel-sentry-build-token", "version": "1"}
  }
}
```

These fragments are **additions** to your existing config, not a replacement. Do not remove database, Cloudflare, iCloud or storage keys.

4. The *optional* `SENTRY_AUTH_TOKEN` needs release/source-map upload permissions. The Worker deploy workflow fetches it from Google Secret Manager **only during the build**, never writes it to GitHub variables or committed files. The Vite plugin uploads hidden source maps, then deletes `.map` files from the published `dist`. Without this token, browser event capture still works, but minified stack locations will be harder to debug.
5. Deploy the unified Cloudflare Worker and perform a **manually authorized GCP release** from `.github/workflows/gcp-deploy.yml` so both API and finite workers receive the new SDK and secret references. The push workflow for GCP only performs offline checks.

## Exact error links

`/v1/observability/sentry-events/{event_id}` is authenticated by Cloudflare Access and FastAPI authorization. It calls `GET https://sentry.io/api/0/organizations/{org}/eventids/{event_id}/` with the API token, verifies the returned issue ID, and redirects to the exact Sentry issue/event permalink.

An ID alone does **not** mean ingestion succeeded. If Sentry rejects, filters, or drops an event, the resolver clearly returns 404/502/503 instead of inventing a link. Cloud Logging remains available via the other button. Missing `SENTRY_DSN` disables SDK capture, and missing Sentry API token disables only exact-link resolution.

## Privacy and costs

No photo bytes, thumbnails, filenames, signed R2 URLs, request bodies, cookies, IPs, SDK breadcrumbs, or variable locals are uploaded. Exceptions retain class names, frames, line numbers, release and safe operational tags. Browser Replay and profiling are disabled. Performance spans are sampled at 10%; errors aren't sampled by the app (Sentry ingestion and account quotas still apply).

Separate **frontend** and **server** DSNs are recommended for clearer issue ownership; the Cloudflare Worker uses the browser DSN for its own sanitized edge HTTP failures. The backend uses the server DSN for both API and job-worker events.

## Validation

- `npm --prefix apps/web run lint && npm --prefix apps/web run typecheck && npm --prefix apps/web test && npm --prefix apps/web run build`
- `uv run ruff check . && uv run mypy apps/api/src gpu bridges && uv run pytest -m 'not integration and not gpu and not e2e'`
- `node --test infra/cloudflare/cloud-run-proxy/worker.test.mjs`
- Trigger an intentionally failing *non-sensitive* test in a staging environment with configured DSNs, then verify one browser event, one API event, and one finite job event; check Sentry issue links and GCP correlation filter before releasing production.

Use the Cloudflare/WIF deployment permissions already provisioned; do not paste tokens or secrets into ChatGPT or an issue.
