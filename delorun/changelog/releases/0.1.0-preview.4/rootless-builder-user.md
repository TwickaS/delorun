---
area: Install and update
section: Fixed
---

- Building a release on a machine whose Docker engine is rootless now compiles the native addon as the container's own root user, which owns the mounted source, instead of as the caller's user id, which the rootless engine cannot write with. A rootful engine builds exactly as before.
