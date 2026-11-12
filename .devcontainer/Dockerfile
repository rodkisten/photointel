# syntax=docker/dockerfile:1.7
# Codespaces mobile-first: Debian 13, Node LTS 26, Python 3.15 via uv.
FROM node:26-trixie-slim AS node-dist
FROM ghcr.io/astral-sh/uv:latest AS uv-dist
FROM mcr.microsoft.com/devcontainers/base:2-trixie

ARG USERNAME=vscode
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    CLOUDSDK_SKIP_PY_COMPILATION=1 \
    CLOUDSDK_PYTHON=/usr/bin/python3 \
    UV_NO_PROGRESS=1 \
    PATH=/home/vscode/.local/bin:/usr/local/bin:${PATH}

# Copy official binaries instead of installing Node through nvm on every shell start.
COPY --from=node-dist /usr/local/ /usr/local/
COPY --from=uv-dist /uv /uvx /usr/local/bin/

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      zsh nano micro vim git gh curl ca-certificates gnupg \
      less man-db manpages procps psmisc lsof tree unzip zip \
      make build-essential pkg-config \
      jq sqlite3 fzf ripgrep fd-find bat eza zoxide \
      shellcheck openssh-client rsync; \
    rm -rf /var/lib/apt/lists/*

# Official Google Cloud CLI apt repository, using a scoped signing key.
RUN set -eux; \
    curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
      | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg; \
    printf '%s\n' \
      'deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main' \
      > /etc/apt/sources.list.d/google-cloud-sdk.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends google-cloud-cli kubectl; \
    rm -rf /var/lib/apt/lists/*

# Wrangler is globally available for convenience. In each project, prefer
# the pinned local version: pnpm add -D wrangler && pnpm exec wrangler ...
RUN set -eux; \
    npm install --global --no-audit --no-fund \
      wrangler@latest pnpm@latest prettier@latest typescript@latest tsx@latest; \
    npm cache clean --force

# The base image ALREADY includes Oh My Zsh, so do not install it twice.
RUN set -eux; \
    test -d "/home/${USERNAME}/.oh-my-zsh"; \
    custom="/home/${USERNAME}/.oh-my-zsh/custom/plugins"; \
    mkdir -p "$custom"; \
    git clone --quiet --depth=1 https://github.com/zsh-users/zsh-autosuggestions.git \
      "$custom/zsh-autosuggestions"; \
    git clone --quiet --depth=1 https://github.com/zsh-users/zsh-syntax-highlighting.git \
      "$custom/zsh-syntax-highlighting"; \
    git clone --quiet --depth=1 https://github.com/zsh-users/zsh-completions.git \
      "$custom/zsh-completions"; \
    chown -R "${USERNAME}:${USERNAME}" "/home/${USERNAME}/.oh-my-zsh/custom"; \
    chsh -s /usr/bin/zsh "$USERNAME"

COPY zsh/zshrc /tmp/rod-zshrc
COPY zsh/rod-mobile.zsh-theme /tmp/rod-mobile.zsh-theme
COPY nano/nanorc /tmp/rod-nanorc
COPY scripts/doctor.sh /usr/local/bin/mobile-doctor

RUN set -eux; \
    install -o "$USERNAME" -g "$USERNAME" -m 0644 \
      /tmp/rod-zshrc "/home/${USERNAME}/.zshrc"; \
    install -o "$USERNAME" -g "$USERNAME" -m 0644 \
      /tmp/rod-mobile.zsh-theme "/home/${USERNAME}/.oh-my-zsh/custom/themes/rod-mobile.zsh-theme"; \
    install -o "$USERNAME" -g "$USERNAME" -m 0644 \
      /tmp/rod-nanorc "/home/${USERNAME}/.nanorc"; \
    chmod 0755 /usr/local/bin/mobile-doctor; \
    rm -f /tmp/rod-zshrc /tmp/rod-mobile.zsh-theme /tmp/rod-nanorc; \
    zsh -n "/home/${USERNAME}/.zshrc"; \
    zsh -n "/home/${USERNAME}/.oh-my-zsh/custom/themes/rod-mobile.zsh-theme"

USER ${USERNAME}
WORKDIR /workspaces

# uv manages a user-scoped Python; system Python remains for the gcloud CLI.
RUN uv python install 3.15 --default \
    && uv tool install ruff \
    && uv tool install pygments \
    && python --version \
    && uv --version \
    && node --version \
    && pnpm --version

SHELL ["/usr/bin/zsh", "-c"]
