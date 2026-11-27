# Rod Module SDK v0.1.0

Source of truth: [`packages/rod-module-sdk`](../../../packages/rod-module-sdk). Contract major: **1**. Approved API shape; experimental implementation verified by local tests, not yet publicly published.

`RodModuleContext` carries workspace, public identity, relative location/navigation, theme/tokens, optional portal container, notifications, instance-owned events, declared capabilities, named authorized API adapters, flags, host identity, lifecycle and abort signal. It never conveys GitHub/Cloudflare/Docker credentials. Capability declarations do not authorize a request; backend adapters remain the enforcement boundary. Initial browser-only Sandbox receives an empty API map.

`RodModuleManifest` is the business manifest. It is separate from the official `mf-manifest.json`. It identifies module/runtime name, release version, source SHA, contract major, standalone URL, expose and capabilities. The host validates approved origins, contract and immutable SHA path **before** registering executable code. Unknown/incompatible releases fail closed.

Each remote exposes `./App`, a React component receiving `{context}`. No second React root/router/global store. Manage checks exported React hook identity before mounting. Both sides require compatible React 19.2.4 singletons; the official plugin also detects JSX/runtime subpaths.

Standalone provides the same contract through a local adapter. A remote's Radix portal must be in its styled boundary; the Sandbox accepts an explicitly supplied container only inside its own shadow root, otherwise it creates one. Parent abort/unmount terminates feature operations. File/workspace IDs are storage identifiers, never proof of ownership.

For the bootstrap integration, RodSandbox depends on `vendor/rodverse-module-sdk-0.1.0.tgz`, generated with `npm pack ./packages/rod-module-sdk --pack-destination <rodsandbox>/vendor`. Its integrity is locked in pnpm. Publishing a canonical package and replacing this transport is pending; do not create divergent source contracts.
