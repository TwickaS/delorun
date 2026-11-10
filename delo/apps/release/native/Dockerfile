# syntax=docker/dockerfile:1.12@sha256:93bfd3b68c109427185cd78b4779fc82b484b0b7618e36d0f104d4d801e66d25
# The toolchain that compiles upstream's native system addon (`native/system`) for a Linux runtime closure: the
# digest-pinned Debian base `images.json` names, with the exact compiler, linker, C library and kernel header packages
# `toolchain.json` pins, installed from the Debian snapshot `toolchain.json` names so the same versions stay available.
# The recipe builds it per OCI platform and compiles in it with no network.
ARG BASE
FROM ${BASE}
ARG SNAPSHOT
ARG PACKAGES
RUN printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: http://snapshot.debian.org/archive/debian-security/%s\nSuites: bookworm-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' "${SNAPSHOT}" "${SNAPSHOT}" > /etc/apt/sources.list.d/debian.sources \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends ${PACKAGES} \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin /var/log/apt /var/log/dpkg.log
