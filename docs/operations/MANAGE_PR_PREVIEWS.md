# 🧪 Manage PR previews: path-based routing

## Public URL contract

- Production stays at `https://photos-manage.migos.club/`.
- Previews live at `https://manage.migos.club/<PR_NUMBER>/`.
- **Every nested route is supported**: `/247/terminal`, `/247/infrastructure`, `/247/triggers`, etc. Terminal is only an example.
- PR number is a positive decimal integer; never accept arbitrary hostnames or URL destinations from the browser.

## Architecture

1. GitHub workflow builds `apps/manage` for the PR head and publishes a **separate** Worker, e.g. `photointel-manage-pr-247`.
2. Cloudflare Workers routes dispatch `manage.migos.club/<PR>/*` to the matching preview Worker and `manage.migos.club/*` to the main Worker. The preview Worker strips its numeric prefix before serving assets. API routes remain disabled until isolated test resources exist.
3. The preview build must use the prefix as its router basename, asset base, and service-worker scope, or use equivalent prefix-safe URL rewriting. Do not assume stripping paths alone makes an SPA work.
4. Cloudflare Access protects the preview hostname **before** traffic reaches the router. Each preview Worker must also enforce authentication and must not expose a publicly reachable unprotected origin.
5. On PR close, delete only that PR's Worker and mapping. Never touch the production Worker.

## Isolation and security requirements

- Preview Workers must not inherit production write bindings or production secrets. Configure a separate preview environment, read-only mock data or explicit test resources.
- Protect the router from SSRF and open redirects: the PR number maps to a server-owned Worker identity; no user-provided URL is fetched.
- Handle WebSocket upgrades, streaming, redirects, CSP, cookie paths, and cache keys without crossing PR boundaries.
- Prevent service workers and cached assets from one PR controlling another PR's scope.
- Do not create a DNS record or attach a custom domain to the production Worker as a placeholder.

## CI and lifecycle

- Do not trigger preview deploys for Dependabot or Renovate, or commits containing `[skip ci]`.
- Build and test first. Deploy only after checks pass, and post the **verified** preview URL in the PR body.
- Update the same PR description section on subsequent deployments, preserving its ChatGPT origin URLs and other content.
- When the PR is closed, clean up only its preview resources. Avoid automatically deploying to production.

## Current state

- [x] URL convention agreed and documented
- [x] Production hostname identified: `photos-manage.migos.club`
- [x] Cloudflare zone `migos.club` confirmed active
- [x] Numbered preview Worker config generator and prefix-aware SPA wiring committed (not yet build-validated)
- [ ] Dedicated preview Worker build with base-path support
- [ ] Cloudflare Access policy for `manage.migos.club`
- [ ] Preview-only bindings and secrets configured
- [x] PR workflow for install, build and dry-run configuration committed
- [ ] Automatic deployment and cleanup after security gate is provisioned
- [ ] DNS/custom domain created and validated
- [ ] HTTP, nested SPA routes, assets and WebSocket smoke tests

**Do not publish a URL as live until its Worker, Access policy and routing are verified.**
