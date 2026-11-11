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
