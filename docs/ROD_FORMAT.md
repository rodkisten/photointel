# 🎨 Rod Universal Format integration

> Integrated into the **existing workflows**, not a new GitHub Actions workflow.

| Repository | Existing workflow | Integration |
| :-- | :-- | :-- |
| Userscripts | `prettier-full.yml` | Shared format + lint before existing Prettier, PR/commit and rich summary |
| Shell | `check.yml` | Additional read-only format job alongside existing filtered CI |
| PhotoIntel | `frontend-format-fix.yml` | Shared format validation after existing selective ESLint/Prettier fix and before its commit step |

The shared TypeScript Action is checked out under `.rod-actions` and built at runtime until versioned standalone bundles are published. The workflow uses the local action with the repository's installed tools and configuration.

## Modes

- `check`: verify without writing source files.
- `fix`: rewrite supported files in the runner checkout.
- `changed`: compare the PR branch against `origin/main`.
- `all`: inspect tracked files across the repository.

The existing workflow's dispatch options and publishing behavior remain authoritative. This integration does **not** add a new workflow, automatic deployment or separate release pipeline.

> [!IMPORTANT]
> Missing tools may be reported as skipped. Zsh receives syntax validation only, not automatic formatting. The full PR CI must be green before merging.

[Shared formatter documentation](https://github.com/rodkisten/github/blob/main/docs/FORMAT.md)
