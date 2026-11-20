# 🎨 Rod Universal Format integration

> Shared formatter from [rodkisten/github](https://github.com/rodkisten/github), integrated without replacing existing build, typecheck, test, deployment or preview workflows.

## Execution modes

| Trigger | Mode | Scope | Writes to remote? |
| :-- | :-- | :-- | :-- |
| Pull request | `check` | `changed` | No |
| Manual dispatch | `check` or `fix` | `changed` or `all` | No |

Open **Actions → 🎨 Rod Universal Format → Run workflow** to select mode and scope. In `fix`, the Action rewrites the runner checkout, but **does not commit or push**. This initial integration is deliberately read-only with respect to GitHub branches; automatic GitHub App commits and sticky PR comments can be enabled after a successful validation run.

## Supported languages

Prettier for JavaScript, TypeScript, React, Vue, CSS, HTML, JSON, YAML, Markdown, GraphQL, Svelte and Astro; `gofmt` for Go; `rustfmt` for Rust; Ruff formatting for Python; `shfmt` and ShellCheck for Bash/POSIX shell; `zsh -n` for Zsh syntax. Some tools must be preinstalled on the runner; missing tools may be reported as skipped. Zsh autoformat is not supported.

## Implementation details

1. Check out the current PR head with full Git history.
2. Install the repository's own dependencies so Prettier and ESLint use local configuration.
3. Check out `rodkisten/github` under `.rod-actions` and build standalone TypeScript Actions from source. The central repository currently does not publish the new formatter bundle in `dist` on `main`, so a direct remote `uses: rodkisten/github/actions/format@main` is **not yet reliable**.
4. Invoke `./.rod-actions/actions/format` using `origin/main` as the diff base.
5. Upload a JSON report artifact and include a readable GitHub Actions job summary.

## Existing workflows

This integration runs **alongside** the existing selective validation, tests, typechecks, previews and deployment pipelines. It does not modify their existing triggers, jobs, branch conditions or release behavior.

> [!IMPORTANT]
> This is the first rollout stage. Verify a real PR run before enabling auto-fix commits. A strict missing-tool policy and release-pinned bundles are recommended before production-wide adoption.

[Central formatter documentation](https://github.com/rodkisten/github/blob/main/docs/FORMAT.md)
