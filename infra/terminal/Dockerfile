FROM gcr.io/google.com/cloudsdktool/google-cloud-cli:stable
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash bash-completion ca-certificates curl wget jq gawk sed coreutils findutils \
    grep less nano vim-tiny git openssh-client openssh-server rsync tmux htop \
    ripgrep fzf unzip zip tar gzip xz-utils dnsutils iproute2 iputils-ping \
    netcat-openbsd procps lsof file make python3 python3-venv python3-pip sudo \
    postgresql-client sqlite3 tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /bin/bash rod \
    && echo 'rod ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/rod \
    && chmod 0440 /etc/sudoers.d/rod
ENV TERM=xterm-256color
USER rod
WORKDIR /home/rod
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
