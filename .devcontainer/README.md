# Codespaces Mobile Devcontainer

A fast, practical Codespaces environment for Safari on an iPhone.

## Installation

This configuration can be installed by the self-contained `install.sh` in the root of the standalone Rod Mobile installer repository. If copied manually, copy the entire `.devcontainer` directory to the **root of your repository**, commit it, and run **Codespaces > Rebuild Container** (or **Dev Containers: Rebuild Container**).

All configuration files must live beside the Dockerfile. You do **not** need to manually install Oh My Zsh; the Microsoft base image already includes it.

## Included

- **Debian 13**, **Node.js 26 LTS**, **pnpm**, **TypeScript**, **tsx**, **Prettier**.
- **Python 3.15** from `uv` (`python`, `python3`, `uv`, `uvx`), plus **Ruff** and **Pygments**.
- **gcloud CLI** (system Python), **kubectl**, **Wrangler** (global convenience), **Git**, **GitHub CLI**.
- **Zsh/Oh My Zsh** with git, gh, gcloud, docker, kubectl, colorize, colored-man-pages, extract, sudo, command-not-found, autosuggestions, completions and syntax highlighting.
- **Nano**, **Micro**, **Vim**, `jq`, `ripgrep`, `fzf`, `fd`, `bat`, `eza`, `zoxide`, `sqlite3`, `shellcheck`, `make`.

## Prompt

```text
/workspaces/photointel git:main
❯ 
```

The first line contains directory + Git branch + an exit code only if a command failed. The second line is always clean. It deliberately avoids an expensive `git status` every time the prompt renders.

## Small-screen commands

| Command | Purpose |
|---|---|
| `ll`, `la`, `lt` | Readable colored file lists / tree |
| `c file.json` | Highlight file contents with `batcat` |
| `ff pattern` | Search files by name |
| `fcd` | Choose a directory with fzf |
| `fh` | Search shell history with fzf; populate command line |
| `up 3` | Go three directories up |
| `mkcd folder` | Create and enter a directory |
| `croot` | Go to the Git repository root |
| `j photos` | Jump to previously used directories via zoxide |
| `gproject` | Show current gcloud project |
| `gset PROJECT_ID` | Set the gcloud project explicitly |
| `wrdev`, `wrdeploy` | Run the project-local Wrangler via pnpm |
| `mobile-doctor` | Print CLI availability and validate shell config |

**Git helpers:** Oh My Zsh includes `gst` (status), `gss` (short status), `ga` (add), `gco` (checkout), `gsw` (switch), `gl` (pull), `gp` (push), etc.

## Design decisions

- `setopt CORRECT` *suggests* corrections to commands but **asks before changing them**. It doesn't correct filenames (`CORRECT_ALL` is off).
- Nano soft-wraps visually, but it does **not** insert newlines into your source files.
- Terminal touch support depends on Safari/xterm.js; Nano settings cannot magically create true touch-selection or caret dragging.
- For Wrangler, install a **local, pinned** version in each repository (`pnpm add -D wrangler`) and use `pnpm exec wrangler` or the `wrdev`/`wrdeploy` shortcuts. The global Wrangler is a fallback.
- Python 3.15 is newest, but some project dependencies may not support it yet. In a particular project, run `uv python install 3.14` and `uv python pin 3.14` if needed.
- `gcloud` is installed, **not authenticated** and no projects, billing, permissions or cloud resources are modified by this image.
- This image includes the Docker **Zsh plugin** but does not start a Docker daemon. If you require Docker builds inside Codespaces, add a Docker-in-Docker feature intentionally because it uses extra CPU/RAM.

## Optional: Docker-in-Docker

In `devcontainer.json`, add:

```json
"features": {
  "ghcr.io/devcontainers/features/docker-in-docker:2": {}
}
```

This is intentionally omitted from the default, lightweight configuration.

## Notes

Build-time installs currently track the newest compatible patch/CLI versions. Rebuild to update. For reproducibility in a production team, pin the Node image digest, uv image digest, npm package versions, and Git clone commits.
