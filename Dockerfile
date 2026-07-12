FROM node:22-slim

RUN useradd -m -u 10001 agent
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

USER agent
WORKDIR /workspace

ENTRYPOINT ["pi"]
