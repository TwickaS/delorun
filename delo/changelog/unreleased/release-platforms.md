---
area: Install and update
section: Added
---

- Delorun 0.1.0 runs on Linux (x64 and arm64) and on Windows through WSL2. A release publishes runtimes for Linux x64 and Linux arm64 only. Running `npx delorun` or `delorun update` on native Windows stops before downloading anything and says Delorun 0.1.0 runs in WSL2, with a link to the guide's WSL2 steps. On a Mac it stops the same way and says macOS joins in a later release. A computer whose platform a release does not list still stops with `PLATFORM_NOT_RELEASED`.
