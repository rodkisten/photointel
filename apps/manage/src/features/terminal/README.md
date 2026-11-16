# Terminal (isolated module)

The /terminal UI loads GET /api/terminal/catalog under the existing Cloudflare Access authentication. Configure MANAGE_TERMINAL_VMS as a JSON array, for example:

```json
[{"id":"ubuntu-primary","label":"Ubuntu principal","host":"ubuntu.internal.example","port":22,"username":"rod","hostKeySha256":"SHA256:REPLACE_WITH_ACTUAL_PINNED_FINGERPRINT"}]
```

The full configuration is validated server-side and requires a pinned SSH host-key SHA256 fingerprint. The example fingerprint is a placeholder and will be rejected until replaced with a real fingerprint. Only IDs and labels are returned. Hostnames, SSH usernames, host-key fingerprints and private credentials must stay server-side in the future gateway configuration. No arbitrary hostname input is accepted. This phase **does not open SSH sessions**.

GitHub Codespaces discovery is read-only and optional. Configure `MANAGE_CODESPACES_USER_TOKEN` as a Worker secret with user-scoped `Codespaces: read` permission for GitHub account `rodkisten`. The backend verifies the token owner via `GET /user`, then calls `GET /user/codespaces`. Tokens and machine addresses are never returned to the browser. An installation token is not used for this endpoint. Codespaces cannot be started or connected until the gateway and authorization flow are complete.

## Remaining
- [x] Isolated navigation and responsive UI
- [x] Authenticated read-only VM catalog
- [x] Read-only GitHub Codespaces discovery using dedicated user-scoped token
- [x] Strict VM config validation and pinned-host-key requirement
- [x] Session-intent endpoint that fails closed until gateway is deployed
- [x] Typed terminal frame protocol with input and resize bounds
- [x] Strict VM-only preflight with authenticated origin, payload bounds and no credential issuance
- [ ] Secure gateway, WebSocket session lifecycle and replay protection
- [ ] WTerm/Ghostty rendering, mobile keyboard and reconnect
- [ ] Build validation and deployment

## Gateway transport

`POST /api/terminal/ticket` issues a 30-second HMAC-SHA256 signed, target-bound ticket only after Cloudflare Access authentication and allowlist checks. The browser upgrades `GET /api/terminal/ws?ticket=...` on the same origin. The Worker forwards to the private HTTPS gateway via WebSocket Upgrade; the gateway must validate the ticket and consume its JTI exactly once. No SSH private key is sent to the browser. Set `MANAGE_TERMINAL_GATEWAY_URL` and `MANAGE_TERMINAL_GATEWAY_SECRET` as Worker secrets, and configure the same secret on the gateway. The gateway should be restricted to requests from the Worker, not publicly reachable without service authentication.

The UI uses WTerm's React DOM renderer and the Ghostty WASM core loaded asynchronously. The UI blocks terminal rendering until Ghostty initializes. No automatic replay of shell input after disconnect.
