# Terminal (isolated module)

The /terminal UI loads GET /api/terminal/catalog under the existing Cloudflare Access authentication. Configure MANAGE_TERMINAL_VMS as a JSON array, for example:

```json
[{"id":"ubuntu-primary","label":"Ubuntu principal"}]
```

Only IDs and labels are returned. Hostnames, SSH usernames, host-key fingerprints and private credentials must stay server-side in the future gateway configuration. No arbitrary hostname input is accepted. This phase **does not open SSH sessions**.

Personal GitHub Codespaces discovery requires a user-scoped authorization flow; the existing GitHub App installation token is not sufficient. Keep the feature disabled until an explicit delegated authorization is implemented.

## Remaining
- [x] Isolated navigation and responsive UI
- [x] Authenticated read-only VM catalog
- [ ] Delegated GitHub Codespaces discovery
- [ ] Secure gateway, host-key pinning, WebSocket session lifecycle
- [ ] WTerm/Ghostty rendering, mobile keyboard and reconnect
- [ ] Build validation and deployment
