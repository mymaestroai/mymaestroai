# Agent sandbox image: a Claude client plus common shell tools, nothing from the hub.
# Built by lib/sandbox.js (`docker build -t agent-hub-sandbox sandbox/`). The hub runs one container per
# sandboxed agent from this image, mounting only that agent's own folders. The container never sees the hub's
# data directory, keys or other agents. The Claude client version is pinned to match the host's.
FROM node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION=latest
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq ripgrep python3 python3-venv less procps openssh-client unzip zip \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force \
    && mkdir -p /home/agent && chmod 777 /home/agent
ENV HOME=/home/agent
ENV PATH=/usr/local/bin:/usr/bin:/bin
WORKDIR /home/agent
# The container idles; the hub runs the client and shell commands inside it with `docker exec`.
CMD ["sleep", "infinity"]
