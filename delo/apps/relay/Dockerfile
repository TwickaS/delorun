# syntax=docker/dockerfile:1.12
# The self-hosted relay image (contract C6). Build it from the repository root, because the data
# plane imports C6's contract package and C20's logger from this repository:
#
#   git archive HEAD | docker build -f delo/apps/relay/Dockerfile -t delo-relay -
#
# The relay runs from source through the repository's tsx launcher, the same way `delorun` starts
# a profile, and it reads its configuration from /etc/delo-relay/relay.yaml. The base is the full
# Debian image because the workspace install runs git and the build runs a native toolchain.
FROM node:24-bookworm

ENV CI=true \
    NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /src

# The whole repository is the build context: the workspace manifests, the packages the relay
# imports, and the tsdown configuration `build:artifacts` runs. A clean checkout keeps the image
# small; a working tree with `node_modules` sends it, so `git archive` is the documented form.
COPY . .

# The client build reads the commit it builds from `git rev-parse HEAD`, and an archive carries no
# history, so the image commits the tree it holds once, under an identity of its own.
RUN git init -q \
 && git add -A \
 && git -c user.email=image@delo-relay.invalid -c user.name=delo-relay commit -qm image \
 && corepack enable \
 && pnpm install --frozen-lockfile \
 && pnpm run build:artifacts \
 && rm -rf /root/.cache /root/.local/share/pnpm/store

# C20's log directory and the state directory are private to the container user: a volume that
# inherits 0755 makes the relay refuse to start, because another user could reach its records.
RUN install -d -m 0700 -o node -g node /var/log/delo-relay /var/lib/delo-relay

USER node

EXPOSE 443

VOLUME ["/var/lib/delo-relay", "/var/log/delo-relay"]

# C6's port. `DELO_RELAY_CONFIG` names another configuration file.
ENV DELO_RELAY_PORT=443

CMD ["node", "--import", "tsx/esm", "delo/apps/relay/src/node/main.ts"]
