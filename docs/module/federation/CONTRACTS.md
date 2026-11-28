# Rod Module SDK v0.1.0

Source of truth: [`packages/rod-module-sdk`](../../../packages/rod-module-sdk). Contract major: **1**. Approved API shape; experimental implementation verified by local tests, not yet publicly published.

`RodModuleContext` carries workspace, public identity, relative location/navigation, theme/tokens, optional portal container, notifications, instance-owned events, declared capabilities, named authorized API adapters, flags, host identity, lifecycle and abort signal. It never conveys GitHub/Cloudflare/Docker credentials. Capability declarations do not authorize a request; backend adapters remain the enforcement boundary. Code receives an empty privileged API map. Sandbox can receive a named `sandbox.runtime` adapter only on an authenticated non-isolated host after explicit server configuration; otherwise that adapter is absent. Code can consume a named `workflow.request` adapter when the host implements scoped backend authorization; it is not enabled in Manage yet.

`RodModuleManifest` is the business manifest. It is separate from the official `mf-manifest.json`. It identifies module/runtime name, release version, source SHA, contract major, standalone URL, expose and capabilities. The host validates approved origins, contract and immutable SHA path **before** registering executable code. Unknown/incompatible releases fail closed.

Each remote exposes `./App`, a React component receiving `{context}`. No second React root/router/global store. Manage checks exported React hook identity before mounting. Both sides require compatible React 19.2.4 singletons; the official plugin also detects JSX/runtime subpaths.

Standalone provides the same contract through a local adapter. A remote's Radix portal must be in its styled boundary; the Sandbox accepts an explicitly supplied container only inside its own shadow root, otherwise it creates one. Parent abort/unmount terminates feature operations. File/workspace IDs are storage identifiers, never proof of ownership.

For the bootstrap integration, RodSandbox and Shell depend on `vendor/rodverse-module-sdk-0.1.0.tgz`, generated with `npm pack ./packages/rod-module-sdk --pack-destination <rodsandbox>/vendor`. Its integrity is locked in pnpm. Publishing a canonical package and replacing this transport is pending; do not create divergent source contracts.

## Workflow Studio adapters

The SDK is the application integration boundary. Inside Code, `StudioAdapter` supplies repositories, route snapshots/navigation, a cancellable request transport, persistence namespace and optional dispatch permission. A scoped QueryClient and store belong to each instance. The standalone adapter owns its router; orb bridges its existing routing/request/DB adapters to the same editor. Manage internal stores are never imported. Requests are limited to Studio `/v1/` endpoints; server authorization remains required even when a host enables dispatch.

## Remote execution contracts

`packages/runtime-contracts` is the canonical Node/Worker-safe schema package, separate from the browser-only Module SDK. It defines build requests/approved target policies, immutable provenance receipts, runtime target policy and idempotent agent operations. Version 1 rejects unknown privileged fields and validates repository/image/workspace/platform compatibility. See [REMOTE_RUNTIME](REMOTE_RUNTIME.md) for trust boundaries and deployment status.
