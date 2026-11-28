# Module build, publication and retention

Approved: independent app deployments and one preview per PR. Implemented and published on Sandbox/Code previews, including live Code rollback; exact CI/deployment results are recorded in [STATUS](STATUS.md).

Code uses the existing Shell `shell-flow-wasm.yml` build and preview/deploy workflows, plus shared setup/reporting actions from `rodkisten/github`. The separate prototype Federation workflow was removed. CI checks out the exact published head SHA, builds/tests the core, typechecks Studio/app and builds standalone plus official Federation artifacts. Existing Shell/WASM checks are preserved.

`/workflow/rod-module.json` is a mutable no-store pointer. `/modules/code/<40-character-sha>/` contains the business manifest, official manifest, ESM entry and chunks with CORS, cross-origin CORP and immutable one-year caching. The Worker rejects missing module assets instead of returning SPA HTML. Public artifacts contain no privileged configuration. `verify-module.mjs` requires exact SHA, identity, contract, standalone entry, publicPath, ESM expose, MIME/CORS/CORP and cache headers after deployment.

Artifacts are archived as `code-<main|prN>-module-<sha>` for 30 days. Two prior archives in the same lane are inspected and included in the next deploy. Path traversal, unexpected directories, SHA mismatch, symlinks, excessive entries/size and cross-lane promotion fail closed. Sandbox uses the corresponding already established pipeline. Manage's service worker bypasses cross-origin modules and manifests.

Use `[skip ci]` on intermediate commits and `[deploy]` on the implementation delivery. Existing PR preview dashboards update in place and concurrency cancels superseded PR builds. Production activation remains independent from publishing an unmerged preview. Package publishing, longer release inventory and authenticated production end-to-end validation remain pending.

## Hosted runtime images

Implemented: the Sandbox manual approved-main caller consumes SHA-pinned `rodkisten/github/.github/workflows/runtime-image.yml`; official Docker Buildx/login/build/push actions run on GitHub-hosted Ubuntu, push GHCR digests and upload a provenance receipt outside the checkout. Each request has a stable correlation UUID and run/attempt artifact. orb reserves before dispatch and reconciles ambiguous outcomes without redispatch. CI builds/tests the agent image without publishing, alongside the existing single Sandbox preview workflow. Canonical runtime contracts are checked in Manage frontend preflight.

Own image publication and VPS deployment remain pending, because the new caller is not yet on main and VPS administrative access is not identified. These builds do not run from PR previews. See [REMOTE_RUNTIME](REMOTE_RUNTIME.md) and STATUS for exact evidence; no temporary remote-command workflow was required.
