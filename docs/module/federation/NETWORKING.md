# Private runtime networking

## Approved

Reuse Cloudflare Tunnel/Access and existing gateways. iPhone clients must use private HTTPS URLs, never a VPS `localhost`. Management APIs and application preview traffic have separate identities/policies. No arbitrary internal-port proxy or public Docker socket.

## Implemented

The agent policy fixes workspace/target/container ports, publishes only to `127.0.0.1`, and returns no public preview URL. The control agent can join the existing trusted Tunnel Docker network using an explicit installation variable. Its proposed `runtime-kvm.migos.club` endpoint is restricted by the Sandbox Worker to an exact HTTPS origin and requires Access service credentials plus a bearer credential. Runtime PR previews are denied before any infrastructure calls.

## Observed / verified

User confirmed the healthy rod-kvm4 Tunnel with protected health, Infisical, Dozzle and Beszel routes. No Tunnel/Access/DNS changes or VPS installation were made. Workspace Docker health and rollback were exercised; that does not verify VPS networking.

## Pending

Create the dedicated management Access route after agent publication/installation. Build the Ports inventory and allowlisted preview gateway with scoped URL grants, ownership, expiry/revocation, WebSocket/HMR forwarding and health/log correlation. Verify from an iPhone. Arbitrary ports, URL-directed upstreams and privileged Manage context must never be accepted from a preview. Full activation procedure/status is in [REMOTE_RUNTIME](REMOTE_RUNTIME.md).
