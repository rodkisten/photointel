# Cloudflare Workers Builds: PhotoIntel

Both Cloudflare Workers are linked to the private GitHub repository
`rodkisten/photointel` on the `main` branch.

| Cloudflare Worker | Build root | Preview command | Production build output |
| --- | --- | --- | --- |
| `photointel` | `apps/web` | `npx wrangler preview --config wrangler.preview.jsonc` | `npx wrangler versions upload --config wrangler.preview.jsonc` |
| `photointel-manage` | `apps/manage` | `npx wrangler preview --config wrangler.jsonc` | `npx wrangler versions upload --config wrangler.jsonc` |

Both use **automatic builds**, **Worker Previews**, caching, and path-includes `*`.
Every matching push to `main` builds a new Worker version; every matching push to
another branch builds an isolated Preview, including branches with pull requests.
Cloudflare can comment the Preview URL on a PR once the build succeeds.

## Important: production deployments are separate

Cloudflare builds upload production versions but do not activate them.
This deliberately preserves the existing GitHub Actions production deployment
pipeline, which retrieves privileged settings from Google Secret Manager using
GitHub OIDC and GCP Workload Identity Federation.

Never change Cloudflare's production deploy commands to plain `wrangler deploy`
without first supplying the full production configuration, bindings, Access
configuration, and Secrets Manager integration. Doing so can overwrite the
working deployments.

## Previews are isolated

The `photointel` Preview blocks the live API and authentication routes and
serves only static frontend assets on `*.workers.dev`.

The `photointel-manage` Preview uses `PHOTOINTEL_PREVIEW=true` to serve static
assets read-only on `*.workers.dev`; it rejects admin APIs, webhooks, and
non-GET/HEAD requests. Scheduled job handlers are disabled in previews.
Neither Preview is intended to authenticate to production GCP, GitHub,
Cloudflare admin APIs, or D1.

## Build token requires rotation

The existing Cloudflare Builds token named `photointel build token` was
reported by Workers Builds as deleted or rolled on 2026-11-05. Both Workers
currently reference this token. The build configuration can be saved, but
the build execution cannot authenticate until the token is replaced.

To restore Builds:

1. In Cloudflare dashboard, open **Workers & Pages** and choose each Worker.
2. Open **Settings > Builds** and choose a new, valid API token under the build
   token setting. Prefer a dedicated `photointel` deployment token with the
   least permissions needed for the two Workers.
3. Verify both the production and Preview settings use the same valid build token.
4. Trigger a new Preview build from a PR and a production build on `main`.
5. Check the build logs and verify that production was not promoted by the
   Cloudflare build.

Do not place Cloudflare API tokens into repository files, PR comments, or
Cloudflare build variables that print to logs.

## One preview per pull request

GitHub Actions `cloudflare-pr-previews.yml` now starts only when a PR is opened or reopened, not on each `synchronize` commit. This means its initial preview is **not automatically refreshed** by later commits; reopen the PR to rebuild it.

**Cloudflare Workers Builds is a separate trigger.** If Preview Builds remain enabled for every branch push, Cloudflare will continue to create independent preview versions on each commit, regardless of GitHub Actions settings. Disable automatic Preview Builds for both Workers (`photointel` and `photointel-manage`) in Cloudflare Dashboard > Workers & Pages > Worker > Settings > Builds > Branch control. Keep GitHub Actions as the single PR preview publisher. Verify the actual dashboard setting after applying the change.
