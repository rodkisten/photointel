# CircleCI synchronization (GitHub is the source of truth)

The source is the GitHub Actions repository variable `GCP_CONFIG_ENV` on
`rodkisten/photointel`. This is **not** a second checked-in .env file.

## Codespaces

1. Connect the PhotoIntel GitHub repository to CircleCI and create the restricted
   organization context `photointel-production`.
2. Create a CircleCI personal API token with permission to edit that context.
   Store it as the **Codespaces secret** `CIRCLECI_TOKEN` (never commit it).
3. Store your CircleCI organization UUID as the Codespaces variable
   `CIRCLECI_ORG_ID`.
4. Ensure `gh auth status` works and that its token can read repository
   Actions variables. The default Codespaces token may not have that permission.

Run:

```bash
python3 infra/circleci/sync.py
python3 infra/circleci/sync.py --apply
```

The first command is a dry-run. The second resolves the context by name,
writes the full multiline `GCP_CONFIG_ENV` through CircleCI API v2 and
writes `GCP_CONFIG_ENV_SHA256`. It does not start any pipeline or change
billing. Values are never printed.

**Security:** Context values cannot be read back. A hash is for drift detection,
not authentication. Restrict context use to trusted projects/users and avoid
putting raw credentials in the source variable.

## Deployment router

The existing GitHub push webhook already targets
`https://photos-hooks.migos.club/hooks/github` and verifies HMAC signatures,
repository, main branch and delivery IDs. CircleCI dispatch requires a
separate provider integration in the Manage router and a CircleCI API token
in the Manage Worker. **It is not yet enabled by this sync script.**

CircleCI's newer API supports triggering pipeline runs for GitHub App
integrations; the legacy `POST /project/{slug}/pipeline` does not.
Do not assume the legacy endpoint works until the CircleCI project connection
type is confirmed. The deploy router must avoid duplicate dispatch with
existing Cloud Build and Cloudflare rules and must require approval for
production operations.

No production deployments, provider-token creation, or billing changes are
performed by these files.

## Manage → CircleCI webhook route

The existing signed GitHub webhook on `photos-hooks.migos.club/hooks/github`
now supports a `circleci` rule with target `release`. On a matching push
to main, Manage reads `GCP_CONFIG_ENV` from the GitHub Actions repository
variable, writes it to the CircleCI context, and triggers a CircleCI pipeline
with `action=release` and `expected_sha=<signed push commit>`. CircleCI
requires human approval and checks the commit SHA before executing the release.
Manage polls pipeline workflow status and includes CircleCI in the runs API.

**Required Manage Worker bindings** (configure securely through the existing
Manage secret-publishing mechanism; do not put the token in Git):

- `CIRCLECI_API_TOKEN`: token authorized to write context variables and trigger/read pipelines
- `CIRCLECI_CONTEXT_ID`: restricted production context UUID
- `CIRCLECI_PROJECT_SLUG`: CircleCI project slug from Project Settings
- `CIRCLECI_DEFINITION_ID`: pipeline definition UUID from Project Settings

The Manage GitHub API token must also have **Actions variables: read** permission.
The CircleCI context must additionally have its CircleCI OIDC provider and service
account configured, as documented in the deploy pipeline setup. Enable exactly
one deploy rule for the relevant paths, and disable overlapping GCP/Cloudflare
push-based release triggers to prevent duplicate deployments.

No automatic CircleCI rule is enabled by this PR; create an enabled rule through
Manage's deploy-router API after credentials, integration and approval policies
have been tested. Existing D1 schema remains unchanged: CircleCI rules are
stored internally with a compatible provider discriminator and mapped back
to `circleci` in API responses.

**Operational caveat:** CircleCI pipeline triggers select the current main
branch; if it advances after the signed webhook, the pipeline's expected SHA
check fails closed. This is intentional.

**Deployment status:** implementation committed to the PR, but not deployed
or tested against a live CircleCI account. No billing changes.
