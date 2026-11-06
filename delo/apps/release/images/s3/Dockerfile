# syntax=docker/dockerfile:1.12@sha256:93bfd3b68c109427185cd78b4779fc82b484b0b7618e36d0f104d4d801e66d25
# The S3 harness image (contract C9) over the digest-pinned Debian base that images.json names: the platform's
# runtime closure, read-only, under /opt/delo/runtime, the harness user delo-harness (uid 1001) and the workspace user
# delo (uid 1000).
ARG BASE
FROM ${BASE}
ARG TARGETARCH
ARG SOURCE_DATE_EPOCH
RUN groupadd --gid 1000 delo && useradd --uid 1000 --gid 1000 --no-create-home --shell /bin/bash delo \
 && groupadd --gid 1001 delo-harness && useradd --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin delo-harness \
 && rm -f /var/log/lastlog /var/log/faillog /etc/shadow- /etc/gshadow- /etc/passwd- /etc/group- /var/cache/ldconfig/aux-cache
COPY closure-${TARGETARCH}/ /opt/delo/runtime/
USER delo-harness
