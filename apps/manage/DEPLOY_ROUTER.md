# Deploy Router (GitHub push → Manage → Cloud Build / Workers Builds)

This integration bypasses **GitHub Actions runners**. It does not bypass billing
or quotas for Google Cloud Build, Cloud Run, Cloudflare Workers Builds, D1,
outbound API requests or xrelay. Existing GitHub Actions workflows and existing
Cloudflare/GCP Git push integrations may still auto-run; disable overlapping
push-triggered deployments before enabling these rules or you may get duplicates.

## Architecture

1. GitHub webhook `push` (main only), HMAC SHA-256 signature, JSON body
2. Cloudflare Worker `photos-hooks.migos.club/hooks/github` (no Access app
   on the hook host; the secret signature is mandatory; all other paths 404)
3. GitHub compare API returns changed blob paths, including renamed paths
4. D1 stores delivery ID, diff, enabled path/glob rules, and unique run IDs
5. Manage dispatches allowlisted providers from D1 rules:
   - Cloudflare Workers Builds API for a **specific commit hash**;
   - Google Cloud Build's **signed webhook trigger** URL stored as a Worker secret.
6. Every two minutes a scheduled Worker checks Cloudflare build status.
7. Google Cloud Build reports final success/failure using a bearer-authenticated
   callback at `photos-hooks.migos.club/hooks/cloud-build`.
8. Each status transition calls an operator-configured xrelay URL with structured
   status, a text summary, run ID, commit, provider and provider link.
9. Access-protected UI: `https://photos-manage.migos.club/triggers`.

**IMPORTANT**: The Cloud Build webhook must have a repository-backed **main**
source, using GitHub 2nd-generation connection, and `_RUN_ID=$(body.run_id)` and `_EVENT_SHA=$(body.after)` and `_EVENT_SHA=$(body.after)`
as a substitution. Without this substitution, the build can run but Manage
cannot associate its callbacks; the record remains `submitted`. A rapid
subsequent push may cause a branch-based Cloud Build trigger to checkout a newer
main commit: configure source revision handling for your trigger if exact SHA
provenance is required. Cloudflare builds use `commit_hash` explicitly.

## Production D1 setup / migrations

The administrative publisher `infra/scripts/deploy_manage.py apply` now:
1. Locates or creates `photointel-manage` D1 via Cloudflare API.
2. Adds the `DEPLOY_DB` binding and both hostnames to generated Wrangler config.
3. Runs `npx wrangler@4 d1 migrations apply DEPLOY_DB --remote --config <generated>`
   against the real production D1, **before** deploying the Worker.
4. Deploys the Worker, then sets all version-pinned secrets.
5. Adds a `*/2 * * * *` scheduled event for status polling.

Migration files live in `apps/manage/migrations/`. Wrangler tracks applied
versions in the D1 `d1_migrations` table and will not apply them twice.
The deploy token must have **D1 Write**, **Workers Scripts Edit**, **Access Apps
Edit**, and existing deployment permissions. The runtime Manage Cloudflare
API token must be **user-scoped** and have **Workers CI Read/Write** for Builds
API endpoints. Without correct scopes, provider introspection and dispatch fail
closed; they never fall back to GitHub Actions.

To deploy manually from an authenticated development VM (with correct
`infra/gcp/config.local.json` and Google credentials), use:

```bash
cd ~/photointel
npm --prefix apps/manage ci
npm --prefix apps/manage run build
python3 infra/scripts/deploy_manage.py apply
```

The generated config, secrets and D1 ID are deliberately **not** checked into
the repo. Directly deploying `apps/manage/wrangler.jsonc` through a generic
Workers Builds trigger may omit the production D1 binding and Access settings.
For the Manage Worker itself, use the specialized publisher, or configure a
Workers Builds build/deploy command that calls that publisher with the required
GCP + Cloudflare credentials, and runs migrations first. Do not set a generic
`wrangler deploy` for the Manage project without full production bindings.

## Secrets

Create versioned Secret Manager references under `workflow_secrets` /
`WORKFLOW_SECRETS__<KEY>__NAME` and `...__VERSION` in
`GCP_CONFIG_ENV`. The publisher reads the pinned values and writes them using
Wrangler `secret put`; no secret is stored in D1.

| Reference key | Manage Worker binding | Purpose |
|---|---|---|
| `MANAGE_GITHUB_WEBHOOK_SECRET` | `GITHUB_WEBHOOK_SECRET` | Random >=32-byte shared HMAC secret |
| `MANAGE_GCP_BUILD_RELEASE_URL` | `GCP_BUILD_WEBHOOK_RELEASE_URL` | Complete GCP :webhook URL with key/secret |
| `MANAGE_GCP_BUILD_PROVISION_URL` | `GCP_BUILD_WEBHOOK_PROVISION_URL` | Separate privileged provisioning webhook |
| `MANAGE_GCP_BUILD_CALLBACK_SECRET` | `GCP_BUILD_CALLBACK_SECRET` | Authenticates GCP status callbacks |
| `MANAGE_XRELAY_NOTIFICATION_URL` | `XRELAY_NOTIFICATION_URL` | xrelay HTTPS endpoint, on `*.migos.club` |
| `MANAGE_XRELAY_NOTIFICATION_TOKEN` | `XRELAY_NOTIFICATION_TOKEN` | xrelay Bearer credential |

The callback secret must **also** be stored in GCP Secret Manager under
`photointel-gcp-build-callback`, because the provided Cloud Build YAML reads
`projects/photointel/secrets/photointel-gcp-build-callback/versions/latest`.
It must match the pinned Manage Worker secret value. Configure optional
non-secret `EXTRA_ENVIRONMENT__MANAGE_XRELAY_CHAT_ID=...` for chat routing.

The relay receives JSON of the form:

```json
{
  "action": "send",
  "event": "photointel.deploy",
  "status": "submitted",
  "text": "🚀 PhotoIntel ...",
  "chat_id": "<configured optional chat>",
  "activity_id": "<stable D1 run UUID>",
  "workflow": "Deploy Router",
  "job": "<rule name>",
  "commit": "<full commit SHA>",
  "provider": "cloudflare",
  "provider_url": "<provider dashboard>"
}
```

Confirm your xrelay deployment accepts this format, or adapt `notify()` in
`apps/manage/src/deploy-router/service.ts` to its actual API. It is not
possible to verify xrelay's route/schema using only this repository.
Use `activity_id` to upsert/edit a single Telegram message if supported.

## GitHub webhook

Go to **GitHub repository → Settings → Webhooks → Add webhook**.

- Payload URL: `https://photos-hooks.migos.club/hooks/github`
- Content type: `application/json`
- Secret: the same value as `GITHUB_WEBHOOK_SECRET`
- Events: **Just the push event**; Active

At most five matching rules may dispatch for one push, to cap surprise spend.\nThe Worker rejects missing/wrong HMAC, unknown GitHub repo, non-main refs,
malformed delivery IDs or unbounded/truncated compare responses. Replay of the
same GitHub delivery cannot create another deployment; routes and deliveries
are persisted with unique keys. Provider request timeouts are marked failed,
not automatically retried (a second request could incur duplicate cost).
Only rules explicitly enabled by an authorized Manage user dispatch builds.

The UI validates patterns against the *actual* GitHub tree and identifies
blob, tree and glob results; it also lists available Cloudflare triggers.

## Cloudflare Workers Builds targets

Each rule points at an existing **Workers Builds trigger UUID**, not a Worker
name. Connect the Worker to the private GitHub repository in Cloudflare
Workers → Settings → Builds, then authorize the Manage runtime API token for
Workers CI Read/Write. The editor can list associated triggers. The provider
API is `POST /accounts/{id}/builds/triggers/{trigger_uuid}/builds` with
`{"commit_hash": "<event after SHA>"}`. Status is read using
`GET /accounts/{id}/builds/builds/{build_uuid}`. Cloudflare's native GitHub
push builds can also run on the same push: disable automatic builds or use
separate rules / path filters to avoid duplicate charges.

## Google Cloud Build targets

Create **two** dedicated Cloud Build webhook triggers (source: connected
private GitHub repository, branch main):
- `release`: `infra/gcp/cloudbuild-manage-release.yaml` (API image, Cloud Run
  Jobs, API, Scheduler). It does not apply Neon migrations.
- `provision`: `infra/gcp/cloudbuild-manage-provision.yaml`
  (default `_MODE=permissions` only; privileged provisioning and API enablement
  must be performed through the administrative GCP setup path, not push events).

For each trigger configure substitution
`_RUN_ID=$(body.run_id)` and `_EVENT_SHA=$(body.after)`, copy the generated authenticated `:webhook`
URL to the corresponding pinned Secret Manager entry above.
Create the `photointel-gcp-config` and
`photointel-gcp-build-callback` secrets with enabled versions; grant the
**Cloud Build trigger execution service account** Secret Accessor on both,
Artifact Registry Writer, Cloud Run admin, scheduler permissions and
`iam.serviceAccounts.actAs` as appropriate, keeping bootstrap separate
from deployment.

The configuration step verifies that the checked-out Cloud Build source SHA matches\n`_EVENT_SHA=$(body.after)`; a mismatch never deploys. The final Cloud Build step posts `success` / `failed` to the Manage
callback and fails the build if an earlier step failed. A failure before
Cloud Build creates a build (e.g., source access or missing secrets) may not
produce a callback; check the Google Cloud console.

## Operational notes / security

- Never add the hook hostname to the Cloudflare Access policy protecting
  `photos-manage.migos.club`; its separate public route accepts only
  signed webhook traffic. All panel paths remain Access-protected.
- GitHub webhook secret: generate a long random secret, never a PAT.
- GCP webhook URLs are *credentials*. Keep them in Secret Manager only.
- Do not allow broad arbitrary URLs, arbitrary build YAML or shell commands
  from the D1 editor.
- Both providers may charge money. Set billing alerts and explicit resource
  caps, and don't enable bootstrap automatically without a need.
- Trigger rules only execute on `refs/heads/main` and a verified GitHub diff.
- No DB migrations are applied to Neon in the automatic backend release.
- You can disable any rule in Manage without deleting its execution history.
