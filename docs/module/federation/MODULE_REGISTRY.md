# Experimental Module Registry

Implementation: Manage `src/features/modules/`. Verification/deploy evidence: [STATUS](STATUS.md).

Open `/modules?module=sandbox` or `?module=code` for the selected workspace (or explicit `?workspace=<id>`). Preferences default to disabled and are local per authenticated identity/workspace/module. The original Sandbox storage key remains compatible. `/sandbox` and `/code` lazy mount their selected remotes; the Code navigation entry opens Workflow Studio.

Production accepts reviewed `sandbox.migos.club` and `shell.migos.club` release artifacts with separate module identities and paths. Development/smoke builds offer fixed loopback origins. PR artifacts are available only on the API-less native Workers preview after exact server-side `/module-host.json` pairing validation. That preview uses synthetic identity and empty privileged API adapters. Current Code pairing is Shell #29; Sandbox uses its merged production release. The privileged host never loads PR code.

The registry displays SHA/version/capabilities, status and load diagnostics, provides standalone links, channels, pinned releases, update and rollback. Configuration collapses when a module is mounted to conserve mobile space. A manifest has a 10-second timeout/one retry; runtime has a 20-second timeout/manual retry and per-module Error Boundary. Version changes reload the page because Federation caches module identities. SHA pins are independent per module. Navigation changes within a module retain its lifecycle/cancellation scope.

A release is pinned on successful load. Update preserves it as a rollback candidate; rollback validates and selects that previous compatible manifest. Immutable artifacts must still exist. Sandbox and Code retain two prior bundles within each PR/main lane and archive bundles for 30 days. No cross-lane artifact promotion occurs. First release has no prior compatible version; errors show an actionable fallback.

Pending: authenticated production smoke, server-side catalog administration, workspace policy persistence across devices, audit history and compatible-version inventory. Browser preferences and capability declarations do not grant authorization.
