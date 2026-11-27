# Migration decisions and next gates

Approved ownership: Manage composes; Shell/Code owns editing; orb owns orchestration; Sandbox owns execution environments; uai owns shared UI. Implementation status is in [STATUS](STATUS.md).

## Workflow editor comparison

Inspected Shell #28 and orb #5. Shell `@code/workflow-core` compiles a simplified step model and replaces the selected job's entire steps array. Although it preserves the surrounding document, step fields outside its small model can disappear. orb `@orb/workflow-core` provides source ranges, targeted CST/source patches, structural validation, inspection and job-dependency editing; its web UI already has a graph and inspector. Therefore **use the existing orb CST/editor implementation as the extraction base**, preserving Shell's useful action-port interactions only after parity tests. Do not build another editor.

The eventual single editor belongs to Code/Shell and talks to orb APIs. Extraction, transport/package publishing and replacement of both current entrypoints remain pending. Neither current editor has been deleted because feature parity and existing URLs have not been proved. Existing Manage workflow screens likewise remain until replacement is verified.

## First release gates

1. Complete CI and authenticated preview smoke for the Sandbox/Manage increment; verify actual CORS/MIME/CSP/Access responses and module rollback. No production activation by default.
2. Real iPhone Safari: keyboard, safe area, CodeMirror, portals, resize, zoom accessibility and navigation back/forward.
3. Publish SDK transport and complete host API/theme/navigation adapters. Move remaining package-manager boundaries to pnpm without invalidating concurrent CI work.
4. Extract orb's editor into the existing Shell repository, adopting the contract and preserving canonical CST behavior. Consolidate legacy entries only after parity.
5. Authorized build broker: existing orb dispatch endpoint is a reusable starting point, not a completed remote build system. Add immutable source/digest provenance and scoped service authorization before any VPS runner. Reuse Actions/GHCR/Compose/Tunnel; no new platform or paid containers.
