# Rod Manage SSH Gateway

Dedicated Node.js WebSocket to SSH gateway, separate from the Cloudflare Worker. It runs on a trusted VM with access to the allowlisted SSH hosts. Expose it **only** through a Cloudflare Tunnel with service-to-service access restrictions; never bind the Node listener publicly.

## Required configuration
- `MANAGE_TERMINAL_GATEWAY_SECRET`: random shared HMAC key (32+ characters), same as Worker secret
- `MANAGE_TERMINAL_VMS_FILE`: absolute path to a protected JSON array identical to the Worker `MANAGE_TERMINAL_VMS`
- `MANAGE_TERMINAL_SSH_KEY_FILE`: absolute path to a dedicated restricted SSH private key
- `PORT`: optional, defaults to 8789 on loopback

Install with `npm install` and run `npm start` from this directory. Configure a Cloudflare Tunnel to forward a private HTTPS hostname to `http://127.0.0.1:8789`. Restrict tunnel ingress so only the trusted Worker can reach the gateway. The Worker signs a short-lived ticket and forwards the upgrade, including a gateway secret header. Tickets are single-use per process. For horizontal scaling, replace in-memory replay tracking with a shared strongly consistent store.

Security constraints: pinned SHA256 host keys, fixed SSH allowlist, 3 simultaneous connections per gateway instance, 15-minute idle timeout, 8 KiB input frames, 1 MiB output backpressure cap. The SSH key and hostnames never reach the browser. This gateway currently supports only VM targets, not Codespaces.

**Do not deploy before verifying Cloudflare Tunnel restrictions, pinned SSH fingerprints, secret synchronization, dependency installation and end-to-end SSH/WebSocket behavior.**

Host-key verification hashes the raw SSH host public key with SHA-256 and compares the base64 fingerprint to the pinned value. Never use `hostVerifier: () => true` or disable host key verification.
