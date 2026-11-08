---
section: Added
---

- Installing Delo with `npx delorun` now downloads the release it publishes, checks every file against the signed manifest and the public release log, and refuses to install anything that does not match; the runtime it installs is kept and reused by later runs, so starting Delo again needs no network.
