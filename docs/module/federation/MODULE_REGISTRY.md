# Experimental Module Registry

Implementation: Manage `src/features/modules/`. Status: local built integration verified; production rollout pending.

Open `/modules` to configure Sandbox for the selected workspace (or explicit `?workspace=<id>`). Preferences are local per authenticated identity/workspace. Default is disabled. `/sandbox` mounts the selected remote lazily. Production channel accepts only `https://sandbox.migos.club`; dev/smoke builds offer a fixed loopback server. PR previews are deliberately not loadable in the privileged host. Preview channel needs an isolated host before activation.

The screen shows version, SHA, capabilities and load diagnostics and links standalone. Manifest fetch has a 10-second timeout and one retry; module load has a 20-second timeout, manual retry and Error Boundary. Changing release/channel uses a page reload because Federation caches module identity. A release is pinned on successful load. “Buscar release atual” preserves it as a rollback candidate; “Rollback” reselects the previous compatible manifest after validation.

A prior release must still exist on the artifact origin. RodSandbox's CI retains two earlier module bundles in each PR/main deployment lane and archives individual immutable bundles for 30 days. Initial rollout has no older compatible bundle; expired/unavailable versions display an error and standalone fallback. Retention/rollback on deployed infrastructure still requires CI and live verification.

Pending: server-side catalog administration, cross-device preferences, audit history, verified version inventory, and preview hosts. Browser configuration is not a security boundary or permission grant.
