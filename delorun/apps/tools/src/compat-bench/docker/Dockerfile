# The bench image, in stages. `base` holds Node, build tools and Playwright's Chromium. `delorun-core` adds Delorun built
# from a named commit (the candidate or the previous release tag) and `stock-core` adds DeepSeek Harness from npm at
# Delorun's upstream base. `delorun` and `stock` add the bench's scripts and the mock model last, so a change to a script
# does not rebuild the heavy layers. `bench image build` makes the build context.
ARG NODE_IMAGE=node:24.22.0-bookworm
FROM ${NODE_IMAGE} AS base
ARG PLAYWRIGHT_VERSION
ENV DEBIAN_FRONTEND=noninteractive CI=1 COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable && mkdir -p /opt/corepack /opt/bench /home/bench/home /home/bench/workspace /out && chmod 1777 /home/bench /home/bench/home /home/bench/workspace /out
WORKDIR /opt/bench
RUN npm init -y >/dev/null && npm install --no-audit --no-fund playwright@${PLAYWRIGHT_VERSION} && npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/* /root/.npm
RUN chmod -R a+rX /opt/bench /opt/pw-browsers

FROM base AS delorun-core
ARG BENCH_COMMIT
COPY source.tar /tmp/source.tar
RUN mkdir -p /opt/delorun && tar -x -f /tmp/source.tar -C /opt/delorun && rm /tmp/source.tar
WORKDIR /opt/delorun
RUN --mount=type=cache,target=/root/.cache/pnpm --mount=type=cache,target=/root/.local/share/pnpm pnpm install --frozen-lockfile
ENV DSH_BUILD_SOURCE_COMMIT=${BENCH_COMMIT} DSH_BUILD_SOURCE_TREE=clean DSH_CLIENT_COMMIT_HASH=${BENCH_COMMIT} DSH_CLIENT_TITLE=Delorun
RUN pnpm run build:artifacts
RUN pnpm --filter './delorun/packages/*' run build
RUN chmod -R a+rX /opt/delorun /opt/corepack && chmod -R a+w /opt/corepack
ENV BENCH_HOST_KIND=delorun BENCH_COMMIT=${BENCH_COMMIT}

FROM base AS stock-core
ARG DSH_VERSION
RUN npm install -g --no-audit --no-fund @deepseek-ai/dsh@${DSH_VERSION} && chmod -R a+w /opt/corepack
ENV BENCH_HOST_KIND=stock BENCH_DSH_VERSION=${DSH_VERSION}

FROM delorun-core AS delorun
WORKDIR /opt/bench
COPY --chmod=755 mock/ /opt/bench/mock/
COPY --chmod=755 container/ /opt/bench/
ENV HOME=/home/bench PATH=/opt/bench/bin:$PATH
LABEL delorun.bench=1

FROM stock-core AS stock
COPY --chmod=755 mock/ /opt/bench/mock/
COPY --chmod=755 container/ /opt/bench/
ENV HOME=/home/bench PATH=/opt/bench/bin:$PATH
LABEL delorun.bench=1
