FROM gcr.io/google.com/cloudsdktool/google-cloud-cli:stable
USER root
RUN DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash bash-completion ca-certificates curl wget jq gawk sed coreutils findutils \
    grep less nano vim-tiny git openssh-client openssh-server rsync tmux htop \
    ripgrep fzf unzip zip tar gzip xz-utils dnsutils iproute2 iputils-ping \
    netcat-openbsd procps lsof file make python3 python3-venv python3-pip sudo zsh \
    postgresql-client sqlite3 tini \
    && rm -rf /var/lib/apt/lists/*
# The Cloud SDK base image puts gcloud outside the ordinary login-shell PATH.
# Tailscale SSH starts `bash -l`, which resets PATH; expose the existing CLI in
# /usr/local/bin so interactive shells and the iCloud installer both find it.
RUN set -eux; \
    cli="$(readlink -f "$(command -v gcloud)")"; \
    test -x "$cli"; \
    ln -sf "$cli" /usr/local/bin/gcloud; \
    printf '%s\n' 'export PATH="/usr/local/bin:/usr/lib/google-cloud-sdk/bin:$PATH"' > /etc/profile.d/photointel-gcloud.sh; \
    bash -lc 'command -v gcloud && gcloud version'; \
    zsh -lc 'command -v gcloud'
# The official Cloud SDK image already contains UID 1000. Keep that UID for
# the persistent volume, reusing the account instead of creating a duplicate.
RUN set -eux; \
    if ! getent group 1000 >/dev/null; then groupadd --gid 1000 rod; fi; \
    if id rod >/dev/null 2>&1; then \
      test "$(id -u rod)" = 1000; \
      usermod --gid 1000 --shell /bin/bash rod; \
    else \
      existing_user="$(getent passwd 1000 | cut -d: -f1)"; \
      if [ -n "$existing_user" ]; then \
        usermod --login rod --home /home/rod --move-home --gid 1000 --shell /bin/bash "$existing_user"; \
      else \
        useradd --create-home --uid 1000 --gid 1000 --shell /bin/bash rod; \
      fi; \
    fi; \
    install -d -o 1000 -g 1000 /home/rod \
    && echo 'rod ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/rod \
    && chmod 0440 /etc/sudoers.d/rod
ENV TERM=xterm-256color
USER rod
WORKDIR /home/rod
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
