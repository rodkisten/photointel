# PhotoIntel + Manage: diagnostics, bulk repair and PR previews

## Navigation and logs

Both apps link to their respective home and to the other app in the topbar.
Failed job tiles open `photos-manage.migos.club/?tab=logs&source=gcp&job=...`,
including correlation ID and execution time when available.

## Apple iCloud sessions

Manage's **iCloud** tab diagnoses the last 24 hours of sanitized Cloud Run logs,
displays recent iCloud preflight runs and links to an actual authenticated Apple
session probe in Photos. The probe reopens the same encrypted session as the
ingestion worker, checks Apple connectivity with a 25-second timeout, and never
downloads photos or returns Apple cookies/passwords/errors.

For a session renewal, open the secure GCP terminal, run:

```sh
python3 infra/scripts/icloud_terminal.py prepare
python3 infra/scripts/icloud_terminal.py setup
python3 infra/scripts/icloud_terminal.py verify
```

Complete the interactive Apple password and 2FA prompts **in that terminal**;
the existing pipeline encrypts the resulting session. The Manage UI intentionally
does not accept an Apple password: it cannot safely publish a refreshed session
or complete 2FA by simply storing a form value. Never add Apple passwords
to GitHub variables, secrets exposed as logs, URLs, query parameters or the browser.

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
