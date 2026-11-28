# Hosted builds and private RodSandbox execution

Approved direction: Manage presents the workspace; RodSandbox owns environments; orb authorizes/orchestrates builds; GitHub-hosted runners compile; GHCR holds immutable images; the VPS pulls and starts them without rebuilding. The user confirmed **rod-kvm4**. Read-only Cloudflare inspection found its healthy Tunnel and Access-protected health/Infisical/Dozzle/Beszel routes. None was changed. Administrative access to install the agent has not been identified.

## Implemented

| Boundary | Implementation | Enforcement |
| --- | --- | --- |
| Manage → Sandbox | Scoped `sandbox.runtime` SDK adapter through authenticated Manage Worker; optional production service binding | Verified host identity, same-origin mutation, fresh server headers; no caller cookies/tokens forwarded. No adapter in isolated preview |
| Sandbox → orb | Worker service binding, private machine credential, forwarded verified subject | Workspace/target/subject allowlist in orb. Standalone verifies signed Access JWT issuer/audience; local UI identity is not authority |
| orb → GitHub | Durable D1 reservation, approved workflow blob and source ancestry, fixed workflow inputs | GitHub App only, idempotency, unknown dispatch reconciliation without automatic repeated builds |
| Runner → GHCR | SHA-pinned shared `runtime-image.yml`, official Docker actions, hosted Ubuntu runner | Default-branch manual caller, immutable source, fixed GHCR repo, bounded context/platforms, no browser commands/build secrets |
| Build → release | Bounded artifact receipt outside checkout | Exact request/workspace/target/repo/workflow SHA/blob/source/run/attempt/image/platform checks. Signed artifact URLs get no GitHub credentials |
| Sandbox → agent | Fixed management origin, Access service identity plus separate bearer | No arbitrary proxy, digest from broker result only; browser cannot supply image/credentials |
| Agent → Docker | Node 24/Elysia; serialized durable operations and per-target/process leases | Local Unix socket, approved targets, digest-only pull, Compose `--no-build --pull never`, nonroot/read-only/resource limits/loopback/named volumes |

The lazy Runtime panel in the existing Sandbox bottom pane requests builds for committed SHAs, polls status, links GitHub logs, **explicitly requests deployment** of a verified successful result, polls health/operations/logs, and offers rollback. Scoped persistence stores identifiers/SHA only. Unmount cancels UI requests/polling, while an already accepted agent operation continues from its journal. This slice does **not** yet automatically deploy a completed build through a reliable server outbox.

Health failure restores the previous image, or stops the failed first release. Explicit rollback swaps retained current/previous images. Persistent volume data is not rolled back. Startup recovers interrupted operations, including a journal written before the state pointer. The implementation handles process crashes, not arbitrary disk/power failure. A filesystem/lock error may require operator recovery.

## Contracts

Canonical package: [`packages/runtime-contracts`](../../../packages/runtime-contracts), schema version 1, runtime Zod validation. Source requests contain only workspace, target, 40-character commit and idempotency UUID. Targets, workflow paths/blob identities, platforms, container health commands, ports and resource budgets are **server policy**. No shell commands, infrastructure credentials, host mounts or image tags are accepted from the browser. The same versioned integrity-locked archive is consumed by orb and Sandbox; publishing to a package registry is pending.

## Activation procedure (pending)

1. Review/merge the Sandbox caller and agent code. The reusable workflow is pinned to [github a22421f5](https://github.com/rodkisten/github/commit/a22421f535303ac5203f74a1f45cf1d8f3f250d2); it is not a PR-preview publisher. Dispatch requires an approved default-branch commit. Publish and verify the agent image digest before VPS installation.
2. Configure orb `ORB_RUNTIME_POLICY` from `apps/api/runtime-policy.example.json`, replacing the deliberately unusable subject and workflow blob with the reviewed values. Obtain the **Git blob SHA** for `.github/workflows/runtime-build.yml` at main, not a commit SHA. Apply migration `0003_runtime_builds.sql` through the existing D1 migration workflow. Provision `ORB_RUNTIME_TOKEN`; GitHub App needs contents/actions read, actions dispatch and package publishing in the runner's scoped GITHUB_TOKEN.
3. Provision Sandbox production Worker only: service `RUNTIME_BROKER=orb-api` via repository variable `RUNTIME_BROKER_SERVICE=orb-api`; secret `RUNTIME_BROKER_TOKEN` matching orb; secret `RUNTIME_CONTROL_TOKEN` matching Manage. For standalone, set `RUNTIME_ACCESS_TEAM_DOMAIN` and `RUNTIME_ACCESS_AUD` for its real Access application. PR configs forcibly set `RUNTIME_PREVIEW=1` and omit all production services/vars.
4. Install only the prebuilt agent on rod-kvm4 using its existing admin access and [Sandbox installation bundle](https://github.com/rodkisten/rodsandbox/tree/feat/remote-build-runtime/runtime). The agent connects to the existing trusted Tunnel Docker network and is reachable there as `rod-runtime-agent:9183`; its host listener stays loopback. Registry read credentials are a separate read-only agent mount, never supplied to workloads.
5. Add a dedicated service-auth Access application/route for proposed `https://runtime-kvm.migos.club` through the existing Tunnel, with origin Access validation and a narrowly scoped service token. This has **not** been created. Configure Sandbox `RUNTIME_AGENT_URL` (only that exact origin accepted), `RUNTIME_AGENT_TOKEN`, `RUNTIME_AGENT_ACCESS_CLIENT_ID` and `RUNTIME_AGENT_ACCESS_CLIENT_SECRET` in existing secret management.
6. Opt in the production Manage publisher with `MANAGE_RUNTIME_SERVICE=rodsandbox` in server configuration and `MANAGE_RUNTIME_CONTROL_TOKEN` via existing workflow secret resolution. It emits the private service binding and Worker secret; native/PR preview never receives them. Partial/unknown configuration fails closed. No production binding was activated here.
7. Run one authorized probe build, inspect provenance/GHCR digest, deploy, inspect health/logs, then verify explicit rollback. Record actual run IDs and the VPS result before marking the chain verified.

The agent and app workloads can be rolled back independently by digest. Do not remove the state/named data volumes when upgrading. Review data migrations separately. Old image cleanup/longer retention policy and automatic deployment outbox remain pending.

## Evidence and limits

Local checks: four contract tests; six broker tests plus three existing API tests; eight agent tests; six Sandbox adapter/JWT tests; three Manage adapter cases. Standalone and Federation builds, workspace typechecks, Worker dry-runs and workflow static validation pass. Real Docker smoke pulls two public GHCR NGINX digests, starts a nonroot/read-only/resource-limited service, runs HTTP health checks, rejects a candidate and restores the previous image. This uses the workspace Docker daemon, **not rod-kvm4** and not a newly published RodSandbox image. Compiled Node agent serves health 200 and rejects an unauthenticated target with 401; the built Docker image passed the same real HTTP probes under CI read-only/resource restrictions after moving its process lease inside the writable state volume. See [evidence](evidence/runtime-docker-smoke.txt). CI and public preview results are recorded in [STATUS](STATUS.md).

No own hosted-image dispatch/GHCR publication, VPS installation, management route, automatic deployment, private service preview URL, physical iPhone/Safari or production end-to-end chain is claimed. The panel deliberately does not turn VPS loopback ports into user preview URLs. Ports/HMR/expiry/revocation requires the subsequent authorized gateway slice; see [NETWORKING](NETWORKING.md).
