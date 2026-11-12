
FROM mcr.microsoft.com/devcontainers/python:3.12-bookworm

# Ferramentas essenciais de desenvolvimento
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        make \
        build-essential \
        pkg-config \
        git \
        curl \
        jq \
        zsh \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# uv oficial, com versão fixa
COPY --from=ghcr.io/astral-sh/uv:0.12.23 \
    /uv /uvx /usr/local/bin/

# Configuração do uv
ENV UV_LINK_MODE=copy \
    UV_CACHE_DIR=/home/vscode/.cache/uv \
    UV_PYTHON_DOWNLOADS=never

RUN mkdir -p /home/vscode/.cache/uv \
    && chown -R vscode:vscode /home/vscode/.cache/uv
