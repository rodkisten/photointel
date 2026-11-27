# Federation implementation status — 2026-11-27

Approved direction remains in [README](README.md). This is an experimental first vertical slice, not a production rollout or a completed ecosystem migration.

## Repository audit

All nine repositories cloned and remote refs refreshed. No existing local edits were overwritten. No Ploocky installation credentials are bound to this environment; GitHub CLI authenticates as `rodkisten`.

| Repository               | Main inspected                             | Active work / finding                                                                                                                                                |
| ------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rodverse/rodverse        | `8a7af87a059ab887c24ee0d0c6c6a52fcf90c540` | #262 open, based on main, originally documentation only. Manage has Vite 8 and React 19; no federation before this increment. Preserve concurrent CI PRs #261/#257.  |
| rodkisten/rodsandbox     | `f19015296379c4adfe0200c87affbb3fa16ee38b` | #11 merged; #12 open and based on main. Vite root exists, default package build still Next. Existing embedded keyboard/ResizeObserver/redirect groundwork confirmed. |
| rodkisten/shell          | `5ea80dce9b6ff68fb17ab8c2fb908105ca979874` | #28 open; main conflicts in two deploy workflows and obsolete source-assertion test were reconciled locally; current validated artifact pipeline now stages Workflow Studio in the same preview. Shell typecheck, Go/WASM frontend build and Workflow Studio build passed; lint has three pre-existing warnings and no errors. Existing federation implementation is separate from the new SDK.                |
| rodkisten/orb            | `ac0d05e54796dbe957a88259078bd5fd430b80d1` | #5 open, no merge conflict. Real YAML CST editing, registry and authorized dispatch APIs exist; no sandbox-to-GHCR-to-VPS chain verified.                            |
| rodkisten/uai            | `9c95d88`                                  | Shared registry source; hostname still described as planned. RodSandbox already consumes copied uai primitives.                                                      |
| rodkisten/userscripts-cf | `322d257c`                                 | React migration and studio consolidation on main. Runtime/AST lifecycle has mandatory migration gates; no changes in this increment.                                 |
| rodkisten/github         | `6e5b217`                                  | Shared setup/reporting actions exist; reused rather than adding another preview workflow. No canonical GHCR runner contract verified.                                |
| rodkisten/rodlog         | `572431e`                                  | Go library; not a frontend remote.                                                                                                                                   |
| rodkisten/rodtui         | `93d3eec`                                  | Go terminal UI; not a frontend remote.                                                                                                                               |

## Implemented

- `packages/rod-module-sdk`: versioned browser-only TypeScript context/manifest contract, runtime validation, malicious-origin/version/SHA cases. pnpm workspace begins with this package; existing Manage npm CI is intentionally retained during migration.
- RodSandbox: same `SandboxApp` for standalone and `./App`; standalone adapter; embedded Shadow DOM with inline Tailwind reset/tokens; configurable contained Radix portals and nonmodal menus; container sizing; user/workspace DB, Git FS, history and snapshot namespaces; abort/unmount handling; worker timeout cleanup; cross-origin module worker bootstrap; SHA-relative TypeScript libraries and WASM.
- Removed direct browser-shell JavaScript evaluation in the host realm; Preview REPL remains isolated. Browser terminal no longer probes the Manage `/api/terminal`. Detached preview disabled while embedded. Removed standalone gesture blockers that prevented accessibility zoom.
- Official `@module-federation/vite` 1.25.1 (supports Vite 5–8), React/React DOM 19.2.4 singleton requirements in host/remote; runtime identity guard. Existing Shell/orb versions are not yet migrated to this contract.
- Manage `/modules` and `/sandbox`: lazy route, runtime registration, bounded manifest/module loading, retry and module boundary, standalone fallback, diagnostic IDs, per-user/workspace browser selection, channel display, release pin and previous-release rollback selection. Production only trusts the reviewed sandbox origin; loopback exists only in dev/smoke build mode. No privileged API adapter or tokens supplied.
- Build packaging: business manifest + official federation manifest under `/modules/sandbox/<SHA>/`; mutable pointer uses no-store; immutable assets use long caching/CORS. CI retains two previous module artifacts from the same PR/main lane for reload-based rollback. This retention path still needs Actions validation.
- Manage CSP now authorizes only reviewed Sandbox artifact paths for scripts/workers/frames, WASM compilation and the declaration CDN; preview code uses an opaque network frame without allow-same-origin.
- Existing Manage service worker bypasses module manifest/artifact paths and cross-origin requests. Existing single-preview workflow and concurrency retained.

## Verified locally

- Manage typecheck and production build.
- Manage: 123 existing tests plus 2 module CSP tests and 3 service worker tests passed.
- RodSandbox: typecheck; standalone and federation builds; 114 tests passed.
- SDK: 8 contract/security tests passed.
- Chromium mobile viewport 390×844 against **built** standalone and actual Manage: same remote loaded across origins; singleton guard passed; CodeMirror rendered; esbuild WASM compiled starter project; preview logs arrived; Radix menu stayed inside shadow; host input font/pointer state unchanged; mounted height matched parent; namespaced IndexedDB; SPA unmount terminated all tracked workers; no browser exceptions or host PTY probes. The final smoke also applied the production Worker CSP template with the Sandbox origin replaced by its loopback equivalent and verified opaque preview origin isolation. Host identity/catalog endpoints mocked locally; remote JS, workers, WASM and previews were real. [Smoke evidence](evidence/chromium-smoke.txt).
- Scoped lint on new Manage module runtime/page and Vite config passed. Full lint encountered generated OpenAPI `any` declarations; no generated files are committed here.

## Not verified / pending

- No production deployment or authenticated live cross-origin smoke. Manage responds with Cloudflare Access redirect. Direct preview-domain probe was blocked by the execution network proxy; this is not evidence of application failure. CI links and preview outcome must be read from the actual new commits.
- WebKit cannot launch: required GTK/Graphene/Harfbuzz/Manette/Hyphen/GLES libraries absent. No claim of Safari or physical iPhone validation.
- Multi-device registry persistence/administration, capability API authorization adapters, full deep-link feature-state synchronization and host theme propagation across all legacy panels remain pending. Local registry preferences are not authorization.
- SDK public release/registry publishing pending. RodSandbox uses a versioned npm-pack tarball from the canonical package, not a copied contract implementation. Repack after contract changes; version before publishing.
- Large pre-existing editor/Git bundles remain. Measure and improve lazy boundaries before broad rollout; no performance budget claimed.
- Workflow editor consolidation, Code/orb/Userscripts remotes, remote build broker, verified GHCR digest delivery, VPS Compose agent and private Ports gateway are not implemented here. Do not expose arbitrary ports or Docker socket to bridge this gap.
