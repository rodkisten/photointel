# PhotoIntel Manage · Operational Control Center

**Separate Cloudflare Worker:** photointel-manage  
**Private URL:** https://photos-manage.migos.club  
**Code:** apps/manage/  
**Auth:** independent Cloudflare Zero Trust Access application, backed by a signed
RS256 JWT, fixed audience and explicit e-mail allowlist. Both HTML and /api/*
require verified Access; no unauthenticated static assets.

This admin panel does not share PhotoIntel's public Worker, routes, assets,
deploy frequency, browser tokens or runtime authorization.

## Available operations

| Screen | Integration |
| --- | --- |
| Visão geral | GitHub Actions, Cloudflare Workers, Cloud Run service inventory and provider status |
| Deploys | Fixed allowlist of workflow_dispatch actions, input choices, confirmation, runs, jobs and step-level logs, retry failed |
| Logs | Cloudflare Workers Observability query API, GCP Cloud Logging (optional OIDC federation), GitHub job logs, recent unresolved Sentry issues |
| Ambiente | Edit the *environment variable* production/GCP_CONFIG_ENV (JSON or dotenv) via GitHub REST, with optimistic SHA-256 version checks and project validation |
| Sistema | Access identity, provider configuration, GCP jobs, Cloudflare worker domain inventory |

The backend returns status 503 with a useful setup hint if a provider is not
configured. It **never** displays simulated or guessed GCP/Cloudflare status.

## First deployment

1. On Google Secret Manager, create a new secret containing a dedicated
   **fine-grained GitHub PAT** for repository rodkisten/photointel (without the
   space), selecting at minimum **Actions: Read and Write** and
   **Environments: Read and Write**. GitHub variables use the Environments
   permission. Use a dedicated credential, not the ephemeral GITHUB_TOKEN.
2. Add to the existing **production Environment variable** GCP_CONFIG_ENV:

   Under extra_environment, add a distinct **administrator-only** allowlist.
   This never inherits PhotoIntel photo-viewer privileges:

       "MANAGE_ACCESS_ALLOWED_EMAILS": "[\"admin@example.com\"]"

   Replace the example address with your authorized operator address(es).
   The first deployment fails closed if this list is missing.

   JSON form, merged into existing workflow_secrets:

       "MANAGE_GITHUB_API_TOKEN": {
         "name": "photointel-manage-github-token", "version": "1"
       }

   Optional dedicated read-only tokens:

       "MANAGE_CLOUDFLARE_API_TOKEN": {
         "name": "photointel-manage-cloudflare-token", "version": "1"
       },
       "MANAGE_SENTRY_API_TOKEN": {
         "name": "photointel-manage-sentry-token", "version": "1"
       }

   They are under the existing workflow_secrets object, **not** top-level
   secrets. Existing deploy machinery grants the GCP deployer accessor rights.
   Do not put token values in GCP_CONFIG_ENV.

3. Run your existing GCP Bootstrap/Setup **apply** to ensure Secret Manager
   permissions for those new workflow secret references. The deployment
   account must be able to read the pinned versions. Provide the version bytes
   separately in Secret Manager.
4. GitHub Actions → **🚀 Manage · Publish** → mode **plan**.
   The plan inventories the intended separate Access application.
5. Select mode **apply**. The job builds apps/manage, creates/reconciles the
   independent Access app photointel-manage using ONLY the dedicated
   MANAGE_ACCESS_ALLOWED_EMAILS admin list, obtains its real audience, deploys the standalone
   Worker at photos-manage.migos.club and sets Worker secrets via stdin.
6. After verifying login, set production Environment variable
   MANAGE_ENABLED=true **as a repository Actions variable** if you want this independent Worker automatically
   published whenever its own files change on main.

The existing photos.migos.club worker, access policies, Cloud Run deploys,
D1, R2, iCloud, image buckets and release workflows remain independent.
Do not enable automatic deploy until the first manual apply succeeds.

**Cloudflare privileges:** the deployment token needs the existing Workers
Scripts and Access Apps/Policies management scopes and custom domain routing
permission. The **runtime** Cloudflare token may be a separate read-only token
with permissions for Workers Scripts Read, Workers Observability Read,
Worker Domains Read. A missing runtime token does not block GitHub functionality.

## Google Cloud without long-lived service account keys

The admin Worker **does not** use Google SA JSON keys. It supports short-lived
Google Security Token Service exchange of the **verified Access JWT** through a
dedicated Google Workload Identity Federation OIDC provider. This is *separate*
from the GitHub Actions OIDC provider.

Create a WIF pool/provider trusting the precise Access issuer
https://YOUR-TEAM.cloudflareaccess.com and allowing **only** the management
application's returned Access AUD. Restrict its attribute mapping and
condition to the approved issuer/audience/email (and a dedicated subject),
then grant the principal a dedicated reader service account with:

- roles/run.viewer
- roles/logging.viewer
- optional roles/cloudscheduler.viewer

If using service-account impersonation, grant **only the selected WIF principal**
roles/iam.workloadIdentityUser on the dedicated read-only service account.

Put the following **non-secret** entries in GCP_CONFIG_ENV extra_environment:

    "MANAGE_GCP_WIF_AUDIENCE":
      "//iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/manage/providers/cloudflare-access",
    "MANAGE_GCP_IMPERSONATE_SERVICE_ACCOUNT":
      "photointel-manage@photointel.iam.gserviceaccount.com"

Run the Manage publish workflow again. This switches on GCP service inventory,
Cloud Run jobs and Cloud Logging. Without it the GCP screens display
"configure WIF" rather than claiming a healthy system.

Cloud Logging queries are bounded to project photointel, limited resource
types, 5-240 minute windows and optional canonical correlation UUIDs. Sensitive
data in log messages are redacted before leaving the Worker.

## Sentry

Add extra_environment.SENTRY_ORG (public Sentry organization slug) and
workflow_secrets.MANAGE_SENTRY_API_TOKEN to see up to 30 recent unresolved
issues. Use a read-only Sentry token with org/project read permissions.
The token is used only on the Worker; never add VITE_SENTRY_API_TOKEN.

## Local development

    cd apps/manage
    npm ci
    npm run typecheck
    npm test
    npm run dev

For actual provider APIs, configure a local Cloudflare Worker with a safe
.dev.vars file (without the space), copied from .dev.vars.example.
The Vite UI proxies /api to the local Wrangler port 8788.

## Guardrails

- Cloudflare Access signed RS256 JWT, required issuer, separate manage
  audience, expiry and allowlisted email on every request, including assets.
- Same-origin write requests only, JSON content type, bounded payloads.
- Backend workflow allowlist; restricted inputs, required explicit confirmation.
- GCP_CONFIG_ENV concurrent editing uses SHA-256 and refuses stale versions
  (409). Existing secrets remain in GCP Secret Manager, never fetched via the
  editor.
- GitHub and cloud provider credentials reside only in Worker secrets, pinned
  Secret Manager versions and never in scripts or API responses.
- Sensitive logs sanitized and bounded; provider errors never return raw response
  bodies or secrets.
- No direct mutation of Cloud Run resources, R2 buckets or Access policies from
  the browser. Cloud deploys happen through established GitHub Actions workflows
  with their own WIF identities and validation gates.

Sources: GitHub REST Actions/Variables; Cloudflare Access and Workers
Observability REST API; Google Security Token Service and Cloud Run/Logging.
