# Reconciliação com a main — 2026-11-28

O PR #263 foi reconciliado com `15f49081` (merge do #261, consolidação de CI). Os quatro conflitos eram em `App.tsx`, `router.tsx`, `types.ts` e `worker.ts`: a formatação recente se sobrepôs às rotas Code e ao protocolo do host de módulos. A resolução mantém a navegação Code, as duas origens pareadas no `/module-host.json`, a ausência de APIs privilegiadas nos previews e as mudanças de CI da main.

A consolidação de preview por artefato do #261 foi preservada. O gatilho `pull_request` remanescente de `frontend-release.yml` foi removido: CI valida e entrega artefatos ao workflow reutilizável de preview; o release de produção continua no push/manual/workflow_call. Isso elimina o build paralelo de PR que ainda contrariava o inventário de CI.

A documentação agora tem atalhos no [README principal](../../../README.md), no [índice docs](../../README.md) e um índice completo no [README desta pasta](README.md). Nenhum documento foi removido ou transferido para outro repositório. A main e um PR aberto podem mostrar versões diferentes; consulte os SHAs/evidências abaixo.

Verificação local após a resolução: Manage typecheck/build, **132 testes + 3 de service worker**, lint sem erros, quatro testes dos contratos de runtime e o teste do seletor de CI. Os dois novos testes de protocolo cobrem as origens Code/Sandbox e o bloqueio de API/mutações no host isolado. Actionlint passou nos workflows de build/release/preview alterados; o catálogo dessa versão da ferramenta não reconhece os labels `ubuntu-26.04` já presentes na main (esses jobs passaram na CI da main). Links relativos dos três índices foram verificados. Nova CI e preview deste merge devem ser conferidos antes de atribuir os resultados antigos ao código reconciliado.

A reconciliação atualiza a branch do PR; não faz merge em produção, não ativa o runtime na VPS e não altera os demais PRs abertos. O histórico de implementação e evidência permanece abaixo.

---

# Current runtime block — 2026-11-28

## Implemented and published for review

- Canonical runtime contracts in Rodverse (`25281d14`), strict schemas and compatibility checks; same integrity-locked package consumed by orb and Sandbox. Manage has an authenticated server adapter with opt-in production binding, and no privileged adapter in isolated previews.
- [Sandbox #16](https://github.com/rodkisten/rodsandbox/pull/16): private Node24/Elysia Compose agent, idempotent process-recovery journal, digest-only pull, nonroot/read-only/resource limits, health rollback, explicit UI build/deploy/rollback/log controls, signed standalone Access validation, scoped persistence/lifecycle, Vite defaults, one existing preview pipeline. Agent installation bundle includes the private Tunnel network wiring; no VPS install occurred.
- [orb #5](https://github.com/rodkisten/orb/pull/5): approved hosted-build broker, D1 reservation before dispatch, App-only fixed workflow calls, source/workflow checks, ambiguous-dispatch reconciliation and bounded provenance-validated receipts. Final formatted head `cca1e30` preserves the canonical shared editor/MCP work.
- [github #16](https://github.com/rodkisten/github/pull/16): SHA-pinned reusable hosted GHCR workflow `a22421f5`; default-branch manual caller, immutable source, official Docker actions, per-run/attempt receipt outside checkout. All four CI checks passed at [46131439362](https://github.com/rodkisten/github/actions/runs/46131439362).
- API-less Manage preview pairs specifically with Sandbox #16 and Code #29. Production origins do not allow these PR remotes.

## Verified locally

Sandbox typecheck, standalone/Federation builds and 120 tests; agent typecheck/build and eight tests; canonical contracts build/four tests; orb workspace typecheck/web build, nine API tests and API Worker dry-run; Manage typecheck/build, 130 tests plus three service-worker tests, including both preview-flag authorization cases. Workflow actionlint passed.

Real workspace Docker smoke pulled two public GHCR images by digest, ran actual HTTP health checks with nonroot/read-only/resource constraints, rejected a candidate and restored the previous image. Compiled Node/Elysia served health 200 and rejected an unauthenticated target with 401. No VPS was used. [Docker evidence](evidence/runtime-docker-smoke.txt).

Built standalone Chromium at 390 px loaded Runtime lazily, called the real preview Worker and received the expected 503 without infrastructure requests; mobile width and tab unmount passed with no browser exceptions. [Browser evidence](evidence/runtime-browser-smoke.txt). Live Manage Federation also loaded the real Sandbox #16 SHA entry, passed React singleton/CSP, rendered the lazy Runtime with no privileged adapter/API calls, and passed isolated-frame/mobile-width/SPA-unmount checks without browser exceptions. [Live evidence](evidence/runtime-federated-smoke.txt).

## Main implementation files

| Repository | Paths |
| --- | --- |
| Rodverse | `packages/runtime-contracts/`, `apps/manage/src/features/runtime/`, module mount/policy, production publisher, existing frontend preflight and this documentation |
| RodSandbox | `packages/runtime-agent/`, `src/runtime/`, existing `SandboxApp`/Playground, `runtime/`, `scripts/install-runtime-agent.sh`, existing Cloudflare workflow and approved-main `runtime-build.yml` caller |
| orb | `apps/api/src/runtime/`, `migrations/0003_runtime_builds.sql`, API route/bindings, canonical contract archive/lock and policy example |
| github | `.github/workflows/runtime-image.yml` |

## Current CI / preview evidence

- Manage source `a6178c4d`, followed by the npm lockfile bot `debab7bb`: [frontend release/preflight](https://github.com/rodverse/rodverse/actions/runs/46132683007) and [native preview](https://github.com/rodverse/rodverse/actions/runs/46132682959) **success**. [Live Sandbox integration](https://pr-263-photointel-manage.kisten.workers.dev/sandbox).
- orb formatted head `cca1e30`: [all four CI targets](https://github.com/rodkisten/orb/actions/runs/46132466082) and [preview](https://github.com/rodkisten/orb/actions/runs/46132466029) **success**. [Standalone orb](https://pr5.orb.migos.club/workspace).
- Sandbox deployment passed in [46132810519](https://github.com/rodkisten/rodsandbox/actions/runs/46132810519); [standalone](https://pr16.sandbox.migos.club/) and actual federated remote were exercised. The initial packaged-agent job exposed a startup defect: its process lease targeted the read-only parent of the state volume. Commit `a36333a` moves the lease into that volume and adds a regression test. [Final CI 46133020552](https://github.com/rodkisten/rodsandbox/actions/runs/46133020552) **passed both deployment and packaged-agent jobs** at head `ea3369e`: actual built container, read-only filesystem/resource limits, HTTP health 200 and unauthenticated target 401. Final public manifest/remote SHA `d278bcec99124d1da2ea23936147bde90a078c3d` was exercised standalone and in Manage; it is the PR merge artifact built by Actions. No image was published by this CI packaging check.
- Rodverse [global CI](https://github.com/rodverse/rodverse/actions/runs/46132683034): frontend/Python passed, security gate failed and multiarch container build is still running at this checkpoint. Historical gitleaks gate remains enabled; inspect the completed run before attributing every finding.

## Pending activation

User confirmed rod-kvm4; existing administrative access method is still missing. New publishing caller is not merged into main, so no own hosted-image dispatch/publication or VPS install is claimed. Production service bindings/allowlists/secrets and dedicated Access management route are not activated. Automatic build-to-deploy outbox, private Ports URLs/HMR/expiry/revocation and physical iPhone Safari remain pending. See [REMOTE_RUNTIME](REMOTE_RUNTIME.md) and [NETWORKING](NETWORKING.md).

---

# Previous Code block — 2026-11-28

## Repository state

Rodverse #262 and Sandbox #14 are merged. Shell #28 merged while this block was in progress; continuation is [Shell #29](https://github.com/rodkisten/shell/pull/29). Existing [orb #5](https://github.com/rodkisten/orb/pull/5) was reconciled with current main, including concurrent MCP APIs; its lockfile conflict was regenerated from main without dropping those dependencies. Manage uses `feat/workflow-studio-consolidation` from current main.

## Implemented

- Canonical orb CST/editor extracted to Shell `workflow-core` / `workflow-studio`. orb consumes integrity-locked versioned packages and retains authorization/orchestration, database names and host adapters. No editor/parser source fork remains there.
- Existing Shell action ports, editable inputs and output wiring use conservative CST patches and review. Legacy drafts retain original storage and unknown source fields. Six core tests cover comments, unrelated bytes/fields, wiring, invalid connections, key serialization and migration.
- Same Code feature standalone and `rod_code/App`; official Vite Federation, React/DOM 19.2.4 singletons, Shadow DOM styles and container queries. Scoped navigation/query/store/DB/request/lifecycle adapters. No privileged workflow transport is provided by Manage yet.
- Manage Code module policy/identity/SHA pin separate from Sandbox; `/code` route and navigation, compact registry, stable scope during URL changes, strict Code #29 preview pairing on the API-less native host. Existing Sandbox storage compatibility retained.
- Exact-head SHA artifacts/manifests, worker CORS/CORP/MIME/cache handling, same-lane prior artifact retention and post-deploy verifier in the single Shell preview pipeline. Prototype demo host/contracts/remote and duplicate Federation workflow removed after real Manage integration passed.
- Manage legacy non-executable diagrams labelled separately; persisted graph data/API preserved pending an explicit migration. See MIGRATION for limits.

## Verified locally

- Manage typecheck/build, 127 Vitest tests and 3 service-worker tests; lint has no errors (existing warnings remain). Policy tests reject PR/cross-module origins and swapped identities.
- Shell Go/WASM/frontend build; core/Studio/app typechecks, standalone/remote bundles; 6 Vitest CST tests. Lint has no errors and two existing warnings.
- orb workspace typecheck/web build, 3 existing API tests and Wrangler API dry-run including current main's MCP dependencies.
- Real Chromium at 390 px: Code standalone and actual dynamic Manage remote, singleton guard, YAML/demo graph/step ports, mounted navigation, local draft reopen, scoped CSS/DB, no horizontal overflow, real SPA unmount and no browser exceptions. Only Manage identity/catalog endpoints were stubbed locally; remote/feature/parser were real. orb's same package opened YAML, rendered its CST graph and reopened drafts using its original DB names without browser exceptions.
- Real public action metadata resolved to SHA; declared ports rendered, dragging output to input produced a reviewed CST patch, and applying/downloading it preserved the comment and existing input. [Evidence](evidence/code-action-ports.txt).
- Local evidence: [Code](evidence/code-local-smoke.txt), [orb shared package](evidence/orb-shared-smoke.txt), [official parser/WASM](evidence/orb-official-parser.txt).

## Published previews and CI evidence

- Shell implementation [`968ff62`](https://github.com/rodkisten/shell/commit/968ff62417a70f0d7dc08e6d217a60694669b7c8): [CI/build/preview 46098996636](https://github.com/rodkisten/shell/actions/runs/46098996636) **success**. Published exact SHA, standalone, business/federation manifests, ESM entry, 21 chunks, MIME/CORS/CORP and immutable cache verified. [Standalone preview](https://pr-29.preview.shell.migos.club/workflow/).
- Manage implementation [`0c033ef5`](https://github.com/rodverse/rodverse/commit/0c033ef5bdce7bb859af8c6006df696649aa9d18): [frontend preflight 46098851993](https://github.com/rodverse/rodverse/actions/runs/46098851993) and [native preview 46098851980](https://github.com/rodverse/rodverse/actions/runs/46098851980) **success**. [Live Code integration](https://pr-263-photointel-manage.kisten.workers.dev/code) verified without API/remote mocks: actual SHA remote and React guard, CSP, draft URL reopen, mobile width, SPA unmount, zero privileged Manage API calls and no browser exceptions. [Evidence](evidence/code-deployed-smoke.txt).
- Independent live rollback verified `11796e1` → `968ff62` → `11796e1` → `968ff62` without a host rebuild. Sandbox then loaded its real compiler/workers/WASM/preview in the same host runtime after Code, with no exceptions or privileged API probes. [Evidence](evidence/code-deployed-rollback.txt).
- orb final formatted implementation [`f5f0000`](https://github.com/rodkisten/orb/commit/f5f00008282a12045a4770fab8a51cc426488e22): [CI 46099207407](https://github.com/rodkisten/orb/actions/runs/46099207407) **success** for API, web, workspace and official parser/WASM. [Preview 46099207355](https://github.com/rodkisten/orb/actions/runs/46099207355) **success**, including authenticated gateway health checks. [orb preview](https://pr5.orb.migos.club/workspace). The initially failing probe referenced removed orb source; it now consumes the canonical package's exported adapter.
- Rodverse [global CI 46098852003](https://github.com/rodverse/rodverse/actions/runs/46098852003) retains the **23 historical gitleaks findings** at [security job](https://github.com/rodverse/rodverse/actions/runs/46098852003/job/140836485398). Frontend/Python jobs passed; the gate was not weakened and no secret values were reproduced. Subsequent documentation-only commits do not change the tested implementation.

## Pending / limits

Production Access identity/dispatch and physical iPhone Safari remain unverified. Chromium mobile emulation is not Safari. Package registry publishing, private API adapters, server-side module administration, complete theme propagation, legacy diagram migration, remaining Shell/orb/Userscripts remotes, remote builds/GHCR/VPS and private Ports remain pending. No production merge/activation was performed by this block.

---

## Previous block (historical evidence; statuses below predate the merges)

# Federation implementation status — 2026-11-27

Approved direction remains in [README](README.md). This is an experimental first vertical slice, not a production rollout or a completed ecosystem migration.

## Repository audit

All nine repositories cloned and remote refs refreshed. No existing local edits were overwritten. No Ploocky installation credentials are bound to this environment; GitHub CLI authenticates as `rodkisten`.

| Repository               | Main inspected                             | Active work / finding                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rodverse/rodverse        | `8a7af87a059ab887c24ee0d0c6c6a52fcf90c540` | #262 open, based on main, originally documentation only. Manage has Vite 8 and React 19; no federation before this increment. Preserve concurrent CI PRs #261/#257.                                                                                                                                                                                                                             |
| rodkisten/rodsandbox     | `f19015296379c4adfe0200c87affbb3fa16ee38b` | #11 merged; #12 merged during this session as `6349b45`; the Federation increment was moved onto that updated main in [#14](https://github.com/rodkisten/rodsandbox/pull/14). Explorer #13 remains independent. Vite root exists, default package build still Next. Existing embedded keyboard/ResizeObserver/redirect groundwork confirmed.                                                    |
| rodkisten/shell          | `5ea80dce9b6ff68fb17ab8c2fb908105ca979874` | #28 open; main conflicts in two deploy workflows and obsolete source-assertion test were reconciled locally; current validated artifact pipeline now stages Workflow Studio in the same preview. Shell typecheck, Go/WASM frontend build and Workflow Studio build passed; lint has three pre-existing warnings and no errors. Existing federation implementation is separate from the new SDK. |
| rodkisten/orb            | `ac0d05e54796dbe957a88259078bd5fd430b80d1` | #5 open, no merge conflict. Real YAML CST editing, registry and authorized dispatch APIs exist; no sandbox-to-GHCR-to-VPS chain verified.                                                                                                                                                                                                                                                       |
| rodkisten/uai            | `9c95d88`                                  | Shared registry source; hostname still described as planned. RodSandbox already consumes copied uai primitives.                                                                                                                                                                                                                                                                                 |
| rodkisten/userscripts-cf | `322d257c`                                 | React migration and studio consolidation on main. Runtime/AST lifecycle has mandatory migration gates; no changes in this increment.                                                                                                                                                                                                                                                            |
| rodkisten/github         | `6e5b217`                                  | Shared setup/reporting actions exist; reused rather than adding another preview workflow. No canonical GHCR runner contract verified.                                                                                                                                                                                                                                                           |
| rodkisten/rodlog         | `572431e`                                  | Go library; not a frontend remote.                                                                                                                                                                                                                                                                                                                                                              |
| rodkisten/rodtui         | `93d3eec`                                  | Go terminal UI; not a frontend remote.                                                                                                                                                                                                                                                                                                                                                          |

## Implemented

- `packages/rod-module-sdk`: versioned browser-only TypeScript context/manifest contract, runtime validation, malicious-origin/version/SHA cases. pnpm workspace begins with this package; existing Manage npm CI is intentionally retained during migration.
- RodSandbox: same `SandboxApp` for standalone and `./App`; standalone adapter; embedded Shadow DOM with inline Tailwind reset/tokens; configurable contained Radix portals and nonmodal menus; container sizing; user/workspace DB, Git FS, history and snapshot namespaces; abort/unmount handling; worker timeout cleanup; cross-origin module worker bootstrap; SHA-relative TypeScript libraries and WASM.
- Removed direct browser-shell JavaScript evaluation in the host realm; Preview REPL remains isolated. Browser terminal no longer probes the Manage `/api/terminal`. Detached preview disabled while embedded. Removed standalone gesture blockers that prevented accessibility zoom.
- Official `@module-federation/vite` 1.25.1 (supports Vite 5–8), React/React DOM 19.2.4 singleton requirements in host/remote; runtime identity guard. Existing Shell/orb versions are not yet migrated to this contract.
- Manage `/modules` and `/sandbox`: lazy route, runtime registration, bounded manifest/module loading, retry and module boundary, standalone fallback, diagnostic IDs, per-user/workspace browser selection, channel display, release pin and previous-release rollback selection. Production only trusts the reviewed sandbox origin; native Workers previews verify a server-provided sidecar and offer only the paired Sandbox #14 preview, synthetic identity and no privileged adapters; loopback exists only in dev/smoke build mode. No privileged API adapter or tokens supplied.
- Build packaging: business manifest + official federation manifest under `/modules/sandbox/<SHA>/`; mutable pointer uses no-store; immutable assets use long caching/CORS. CI retains two previous module artifacts from the same PR/main lane for reload-based rollback. Archive upload and retention of a previous bundle passed Actions; reload-based switching/rollback between two deployed SHAs passed a real browser smoke.
- Manage CSP now authorizes only reviewed Sandbox artifact paths for scripts/workers/frames, WASM compilation and the declaration CDN; preview code uses an opaque network frame without allow-same-origin.
- Existing Manage service worker bypasses module manifest/artifact paths and cross-origin requests. Existing single-preview workflow and concurrency retained.

## Verified locally

- Manage typecheck and production build.
- Manage: 125 tests (including 2 module CSP cases) and 3 service worker tests passed.
- RodSandbox: typecheck; standalone and federation builds; 114 tests passed.
- SDK: 8 contract/security tests passed.
- Chromium mobile viewport 390×844 against **built** standalone and actual Manage: same remote loaded across origins; singleton guard passed; CodeMirror rendered; esbuild WASM compiled starter project; preview logs arrived; Radix menu stayed inside shadow; host input font/pointer state unchanged; mounted height matched parent; namespaced IndexedDB; SPA unmount terminated all tracked workers; no browser exceptions or host PTY probes. The final smoke also applied the production Worker CSP template with the Sandbox origin replaced by its loopback equivalent and verified opaque preview origin isolation. Host identity/catalog endpoints mocked locally; remote JS, workers, WASM and previews were real. [Smoke evidence](evidence/chromium-smoke.txt).
- Scoped lint on new Manage module runtime/page and Vite config passed. Full lint encountered generated OpenAPI `any` declarations; no generated files are committed here.

## Not verified / pending

- Sandbox #14 CI and deployment passed at [run 45997645394](https://github.com/rodkisten/rodsandbox/actions/runs/45997645394); the public standalone [preview](https://pr14.sandbox.migos.club/) passed a real Chromium mobile browser smoke (editor + compilation + preview logs, no exceptions). Shell #28 Federation and deployment passed at [run 45997599473](https://github.com/rodkisten/shell/actions/runs/45997599473). Manage frontend preflight and isolated preview publication passed at [run 45997425266](https://github.com/rodverse/rodverse/actions/runs/45997425266). The short preview URL returned 503 despite publication, so do not call the shortcut healthy.
- Rodverse global CI remains blocked by 23 historical gitleaks findings at [security job](https://github.com/rodverse/rodverse/actions/runs/45997425294/job/140500481962); no finding comes from the new module files. No secret values are reproduced and the gate is not weakened.
- Live integration now verified at the [native isolated Manage preview](https://pr-262-photointel-manage.kisten.workers.dev/sandbox) with the [Sandbox PR #14 preview](https://pr14.sandbox.migos.club/): real remote, compiler, workers, WASM and preview logs, zero privileged API requests and no browser exceptions. [Evidence](evidence/deployed-federation.txt). Independent rollback also verified from `411caf8` to `fbced1f` and back, using retained immutable artifacts and no host rebuild. [Evidence](evidence/deployed-rollback.txt). Sandbox verifier initially caught an old pointer immediately after deployment; bounded retries now wait for propagation while still requiring the exact published SHA.
- No production activation or authenticated production-host smoke. Manage responds with Cloudflare Access redirect. Direct preview-domain probe was blocked by the execution network proxy; this is not evidence of application failure. CI links and preview outcome must be read from the actual new commits.
- WebKit cannot launch: required GTK/Graphene/Harfbuzz/Manette/Hyphen/GLES libraries absent. No claim of Safari or physical iPhone validation.
- Multi-device registry persistence/administration, capability API authorization adapters, full deep-link feature-state synchronization and host theme propagation across all legacy panels remain pending. Local registry preferences are not authorization.
- SDK public release/registry publishing pending. RodSandbox uses a versioned npm-pack tarball from the canonical package, not a copied contract implementation. Repack after contract changes; version before publishing.
- Large pre-existing editor/Git bundles remain. Measure and improve lazy boundaries before broad rollout; no performance budget claimed.
- Workflow editor consolidation, Code/orb/Userscripts remotes, remote build broker, verified GHCR digest delivery, VPS Compose agent and private Ports gateway are not implemented here. Do not expose arbitrary ports or Docker socket to bridge this gap.

## Final verification for this block

- Sandbox source [a5f4087](https://github.com/rodkisten/rodsandbox/commit/a5f4087e467d6298d01363711f7d9e0c5bf549ac): [CI/deploy 45999184423](https://github.com/rodkisten/rodsandbox/actions/runs/45999184423) **success**. Verified published merge SHA `5c9635c750db09ce0d81852fb45aea1c48ebc347`, ESM entry, four worker/WASM assets, MIME, CORS and cache headers; retained `fbced1f` and `411caf8`.
- Manage implementation [e3917ccf](https://github.com/rodverse/rodverse/commit/e3917ccf9e6c433041fe86a1d3b0d0a2881fcdc3): [frontend preflight 45998682596](https://github.com/rodverse/rodverse/actions/runs/45998682596) and [native preview 45998682721](https://github.com/rodverse/rodverse/actions/runs/45998682721) **success**. [Global CI 45998682547](https://github.com/rodverse/rodverse/actions/runs/45998682547) has green frontend/Python jobs and a red historical gitleaks gate. Subsequent documentation-only commits do not change the tested implementation.
- Shell source [ddac3f3](https://github.com/rodkisten/shell/commit/ddac3f3c086e91b141ebfc1fae61b6503f25975e): Federation CI and [preview deployment 45997599473](https://github.com/rodkisten/shell/actions/runs/45997599473) **success**. Live [Workflow Studio](https://pr-28.preview.shell.migos.club/workflow/) loaded its heading and React Flow canvas in Chromium without exceptions. It is not yet the consolidated editor or a Manage SDK remote.

No production merge or host activation was performed. Next implementation block: publish the SDK transport, complete host navigation/API adapters, extract the orb CST/editor implementation into Code and retire competing entries only after parity; then complete the authorized Actions/GHCR/VPS and private Ports chain.
