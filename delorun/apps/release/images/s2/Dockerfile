# syntax=docker/dockerfile:1.12@sha256:93bfd3b68c109427185cd78b4779fc82b484b0b7618e36d0f104d4d801e66d25
# The S2 workspace image (contract C9) over the digest-pinned Debian base that images.json names. Workspace commands
# run in it as the workspace user the supervisor chooses; the helper's socket directory exists empty.
ARG BASE
FROM ${BASE}
RUN mkdir -m 0700 /run/delorun-helper && rm -f /var/cache/ldconfig/aux-cache
