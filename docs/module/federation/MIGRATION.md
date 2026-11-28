# Migration decisions and next gates

Approved ownership: Manage composes; Code/Shell owns editing; orb owns orchestration; Sandbox owns execution environments; uai owns shared UI. Verification and deployment evidence live in [STATUS](STATUS.md).

## Workflow editor consolidation

The original Shell model replaced a job's step array and could discard unknown step fields. orb's implementation already provided YAML CST ranges, targeted patches, structural validation, a graph and inspector. That implementation was extracted into the existing Shell repository:

- `packages/workflow-core`: canonical parse/inspect/validate/transform implementation, field patches, output/input wiring and legacy Shell draft conversion.
- `packages/workflow-studio`: one source editor, graph, inspector, patch review, action registry and dispatch UI with injected host adapters.
- `apps/workflow`: standalone TanStack Router adapter and SDK `./App` adapter. No router/root is created by the remote.
- orb `pages/api-workbench.tsx`: host adapter for the same package. `@orb/workflow-core` is a compatibility re-export; the editor/parser implementation was removed from orb.

The original Orb dispatch origin/identity/repository authorization is preserved. Code's public adapter reads fixed GitHub public origins without credentials and performs CST operations locally; private reads/dispatch require a future authorized host adapter. No host credentials are forwarded.

Shell action port interactions were retained against CST rather than a competing step model. Existing `code.workflow.v1` data is imported without deleting the original; migration failures remain visible. orb keeps its existing Dexie database names. Source-package tarballs are versioned and integrity-locked until package registry publishing is established.

Real Chromium standalone, Manage Federation and orb package consumption passed locally, including URL draft reopen and actual SPA unmount. The obsolete `apps/federation-host`, ad hoc contracts/helper, root MemoryRouter remote and duplicate Federation workflow were retired after the real Manage smoke. The actual standalone Shell and its APIs/WASM/R2 routes remain.

Manage's old `/workflows` page stores non-executable diagram JSON with node labels/kinds; it has no GitHub Actions mapping. It is clearly labelled as legacy diagrams and links Code. Its persisted D1 data/API are preserved. Data migration and retirement of that separate graph editor remain pending; converting arbitrary diagrams into executable workflows would invent semantics.

## Remaining gates

1. Preview SHA/MIME/CORS/CORP/cache verification and deployed Code/Manage smoke. Current CI status is in STATUS.
2. Physical iPhone Safari: keyboard, safe areas, CodeMirror, portals, resize, accessibility zoom and back/forward. Chromium mobile emulation is not Safari evidence.
3. Canonical SDK/Studio publishing, authorized host API adapters, theme propagation and server-side module catalog. Preserve package manager boundaries until their CI is migrated atomically.
4. Authorized build broker with immutable source/digest provenance before VPS execution; reuse orb dispatch, Actions/GHCR/Compose/Tunnel. No arbitrary build dispatch, public Docker socket, open proxy or paid container platform.
5. Private Ports gateway, remaining Shell feature entrypoints, orb orchestration remote and Userscripts Studio. No redundant application/repository.
