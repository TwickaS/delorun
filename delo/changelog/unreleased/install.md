---
area: Install and update
section: Added
---

- Installing Delo with `npx delorun` downloads the release it publishes, checks every file against the signed manifest and the public release log, and refuses to install anything that does not match. The runtime it installs is kept and reused, so starting Delo again needs no network.
- `--release` is refused, with both versions named, when a runtime is already installed, instead of being ignored. `--` ends the launcher's own options, so the runtime keeps its own `--release` and `--profile`.
- An install whose download fills the disk stops with the launcher's own message instead of a raw file-system error.
