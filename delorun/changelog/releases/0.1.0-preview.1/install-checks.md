---
area: Install and update
section: Security
---

- Starting an installed runtime does not trust a release root merely because a file under `~/.delorun/trust/` names a newer version: the launcher keeps the root chain the install walked, checks that it leads from a root the launcher carries, and otherwise stops and offers a reinstall. It starts a runtime only when the release root the home stored is one the launcher ships.
- An installed runtime is made read-only before its files are hashed, so nothing can change a file between its check and the mode that protects it.
- The runtime starts without the `NODE_OPTIONS`, `NODE_PATH`, `LD_*`, `DYLD_*`, `NODE_EXTRA_CA_CERTS` and `NODE_TLS_REJECT_UNAUTHORIZED` variables that the shell passed in, so the shell that started `delorun` cannot stand between the runtime and the connections it verifies. A profile name that would leave the Delorun home is refused before anything is read.
- The release-log check accepts every consistency proof the log serves and refuses only one that does not reproduce both tree roots. It also refuses a bundle that names a different manifest file than the release's own, a release version that is not a version, and a checkpoint that no listed witness has signed, even when the trusted root carries no witness requirement of its own. A log entry whose signing key cannot be read says why in its refusal.
