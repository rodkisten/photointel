# Module and preview trust boundaries

Approved: only reviewed releases execute in Manage's realm; Federation and Shadow DOM are not security isolation. Implemented experimental Sandbox path; local tests verified, production Access/CORS smoke pending.

Manage validates business manifest origin, immutable SHA path, module identity and contract before registering a remote. Runtime also rejects a different React instance. Production catalog never permits PR preview origins. Identity is public metadata, and no privileged API clients/tokens are passed to this browser-only module. Authenticated backend authorization remains independent.

Shadow DOM contains Tailwind Preflight and module styling. Radix menus are nonmodal when embedded and stay within the styled module boundary. This prevents accidental CSS/interaction leakage, not malicious remote execution.

User code executes in a separate network-loaded preview document with sandbox `allow-scripts allow-modals`, **without allow-same-origin**. The previous srcdoc + scripts + same-origin combination was unsafe. Only the actual embedding parent may send bootstrap HTML; parent accepts logs only from its own frame/window and matching run identifier. The frame receives generated code, never host context or credentials. Browser terminal evaluation is disabled in favor of this isolated REPL.

Manage's CSP permits executable remote assets only below the reviewed Sandbox `/modules/sandbox/` path, blob workers, WASM and public declaration fetching from jsDelivr. It does not enable host inline scripts or JavaScript eval. A network preview document has its own opaque sandbox and does not need to weaken the host's CSP to execute user code. New policy unit tests and a built browser smoke with this policy template passed.

The existing service worker bypasses remote manifests/artifacts; no remote account data is precached. Retention merges artifacts only within the same PR/main lane, checks archive paths, SHA, size and symlinks. No preview artifact is promoted to production by that retention step.

Pending: authenticated live Access/MIME/CSP validation, physical iPhone Safari, backend capability adapters, module catalog administration and controlled remote execution/Ports. No public Docker socket, arbitrary internal proxy or paid container platform was introduced.
