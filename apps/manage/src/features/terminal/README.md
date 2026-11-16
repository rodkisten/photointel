# Terminal (isolated module)

The /terminal UI loads GET /api/terminal/catalog under the existing Cloudflare Access authentication. Configure MANAGE_TERMINAL_VMS as a JSON array, for example:

```json
[{"id":"ubuntu-primary","label":"Ubuntu principal"}]
```

Only IDs and labels are returned. Hostnames, SSH usernames, host-key fingerprints and private credentials must stay server-side in the future gateway configuration. No arbitrary hostname input is accepted. This phase **does not open SSH sessions**.

GitHub Codespaces discovery is read-only and optional. Configure `MANAGE_CODESPACES_USER_TOKEN` as a Worker secret with user-scoped `Codespaces: read` permission for GitHub account `rodkisten`. The backend verifies the token owner via `GET /user`, then calls `GET /user/codespaces`. Tokens and machine addresses are never returned to the browser. An installation token is not used for this endpoint. Codespaces cannot be started or connected until the gateway and authorization flow are complete.

## Remaining
- [x] Isolated navigation and responsive UI
- [x] Authenticated read-only VM catalog
- [x] Read-only GitHub Codespaces discovery using dedicated user-scoped token
- [ ] Secure gateway, host-key pinning, WebSocket session lifecycle
- [ ] WTerm/Ghostty rendering, mobile keyboard and reconnect
- [ ] Build validation and deployment
