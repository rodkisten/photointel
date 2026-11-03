# PhotoIntel + Manage: diagnostics, bulk repair and PR previews

## Navigation and logs

Both apps link to their respective home and to the other app in the topbar.
Failed job tiles open `photos-manage.migos.club/?tab=logs&source=gcp&job=...`,
including correlation ID and execution time when available.

## Apple iCloud sessions

The Manage **iCloud** tab now provides a native browser login:

1. Enter the password of the **existing configured Apple account**.
2. If Apple requests MFA, type the six-digit code shown on a trusted device.
3. The backend tests live access to the configured Photos library before replacing
   the active encrypted session. No media import or download is scheduled.
4. The intermediate 2FA cookie bundle is AES-256-GCM encrypted, bound to the
   authenticated Manage admin identity and configured Apple account, carried
   only in short-lived browser memory, and expires after ten minutes. The
   account password is not stored by the Manage Worker or PhotoIntel.
5. The Manage Worker forwards credentials only to the private, fixed Cloud Run
   API origin discovered with the authenticated GCP control plane. The backend
   verifies the signed Access JWT and separate Manage admin email allowlist.

The browser login first checks the API's `/v1/ingestion/web-auth/status`
readiness endpoint. A **32-byte Base64 AES key** is infrastructure configuration,
not a 32-character password rule. The API service account must have scoped
`roles/secretmanager.secretAccessor` access to the existing `ICLOUD_SESSION_KEY`
secret and a pinned runtime secret reference, the same encryption key used by
the worker. The GCP bootstrap permissions workflow grants access on that single
secret, and the production API release reconciles its environment.
The UI includes password, 2FA/2SA code, expiration recovery, and confirmation
screens without persisting the Apple code or password.

The existing CLI method remains available only as an optional recovery fallback;
it is **not required** for ordinary login in the Manage UI. Never add Apple
passwords to GitHub Variables, Secret Manager, Actions workflows, URL parameters,
browser storage or logs. The backend masks expected authentication failures.

Apple may require additional security challenges not exposed by icloudpd 1.32.3
or disallow programmatic iCloud access under Advanced Data Protection/security
key policies. Those cases must show a real error instead of claiming the
session was renewed.

The UI offers a proactive reauthentication link when the ingestion status
reports `expired`, `verification_required` or `not_configured`; the log
diagnostics may flag suspected authentication errors, but do not silently claim
that the token is valid based on cookie existence.

## Bulk preview repair

The audit UI lets the operator enqueue up to 100 missing previews per action:
four pages of 25. The server invokes the existing per-asset guarded recovery
path for each requested item, respects prior active jobs and source-manifest
requirements, and reports counts of requested/active/failed jobs. These are
**queued** requests, not finished photos. Resume on the next page rather than
launching unbounded Apple downloads.

## GitHub variables

The Manage configuration page edits `GCP_CONFIG_ENV` with CodeMirror or a
key/value view, preserving original comments and blank lines; separate GitHub
repository/environment variables can also be inspected and edited. Variable
updates use optimistic hashes. These GitHub **Variables** are not a secrets
store and must not be used for credentials. Secret Manager remains separate.

## PR previews

Cloudflare Workers Previews require **Wrangler >= 4.135.0** and the dedicated
`previews` config; production variables/secrets/bindings are not inherited.

- **Photos:** `apps/web/wrangler.preview.jsonc` bundles the SPA with the same
  Worker code, but all `/v1/` and authentication routes are disabled on
  its `workers.dev` preview hostname. No production Cloud Run or iCloud data.
- **Manage:** `apps/manage/wrangler.jsonc` has a preview-specific configuration,
  GitHub Environment `preview` and nonproduction GCP project name. The Manage
  Worker continues to require signed Cloudflare Access for its UI and API.
  Before using the Preview, configure Access for the preview hostname and
  add the preview-only Access audience, allowlist and necessary bindings.
- **GitHub Actions:** `.github/workflows/cloudflare-pr-previews.yml` builds both
  apps for an internal PR. Create a protected GitHub Environment named
  `preview` containing `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
  scoped to preview resources; do **not** copy privileged production tokens.
  Missing credentials produce a warning without falsely claiming deployment.
- **Cloudflare Workers Builds:** connect both Workers to this GitHub repository,
  configure root directories (`apps/web` and `apps/manage`), enable
  **Preview Builds** under Settings > Build > Branch control, and set Preview
  command `npx wrangler preview` (Photos uses
  `npx wrangler preview --config wrangler.preview.jsonc`). Once configured,
  Cloudflare adds preview links to PRs.

Preview variables use the same safe key names as production, with separate
preview values. Sensitive environment variables must be recreated in the
preview environment only after assigning preview-scoped permissions.

See: https://developers.cloudflare.com/workers/previews/get-started/
