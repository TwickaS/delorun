---
area: Safety and privacy
section: Changed
---

- The threat model, the execution-vectors page, the contracts and the package READMEs state only the protections the code provides, and where each applies: Delorun's confinement, consents, fetch guard and privacy defaults apply to the profile that `delorun` and `delorun start` run, not to `delorun headless`, `delorun plugin` or the desktop app, and on Windows the sandbox confines writes only. Each contract page opens with what is built, and protections that are not built, such as reach, Docker workspaces, the plugin revocation list and most `delorun verify` checks, are described as design pages instead.
