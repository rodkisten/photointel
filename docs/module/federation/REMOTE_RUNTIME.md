# Hosted builds and private RodSandbox execution

Approved target: the user confirmed the existing `rod-kvm4` VPS. Read-only Cloudflare inspection found its healthy remotely managed Tunnel and protected health/Infisical/Dozzle/Beszel routes. No existing route, Access policy, container or secret was modified.

## Implemented in progress

- Canonical `packages/runtime-contracts` uses runtime schema validation for immutable source requests, approved build targets, provenance results and agent operations. Contracts do not accept shell commands, credentials, host mounts or arbitrary image tags.
- orb reserves builds durably before dispatch, binds requests to workspace/subject/server policy, checks approved workflow/source ancestry, and does not automatically repeat an ambiguous dispatch. Result artifacts must match workflow, repository, run/attempt, source SHA, request, target, image repository and platforms. GitHub credentials are never forwarded to signed artifact downloads.
- The RodSandbox agent accepts configured targets only. It pulls by digest and uses Compose `--no-build --pull never`, bounded resources, non-root workloads, dropped capabilities, read-only root filesystems, loopback ports and named volumes. Its operation journal survives browser disconnects and is recovered at startup. Health failure restores the previous image when available; rollback does not restore volume data.

## Verification so far

Four contract tests and six broker authorization/idempotency/provenance tests passed locally. Agent health/rollback/recovery tests, shared hosted workflow, real Docker smoke and UI integration are in progress. This is not yet a deployed build-to-VPS chain.

## Required before activation

Publish/verify the hosted build workflow and agent image; configure approved target definitions and machine credentials through existing secret management; establish the already configured administrative access method for installing the agent on `rod-kvm4`. Reuse existing Tunnel/Access with a scoped management route after local/CI validation. No Kubernetes, open Docker socket, arbitrary port proxy or paid container platform.

Private Ports/HMR gateway and physical iPhone Safari validation follow the build/agent chain. Internal loopback addresses are not presented as user-accessible preview URLs.
