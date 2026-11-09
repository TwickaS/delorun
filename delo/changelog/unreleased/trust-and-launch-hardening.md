---
section: Security
---

- Delo now refuses an archive that hides a configuration expression behind JSON escapes, so a customisation value that reads as a tagged expression is caught after it is decoded as well as in the file's raw text.
- Starting an installed runtime no longer trusts a release root merely because a file under `~/.delo/trust/` names a newer version: the launch keeps the root chain an install walked and checks that it leads from a root the launcher carries, and otherwise stops with a reinstall offered.
- The launcher no longer passes a parent process's `NODE_EXTRA_CA_CERTS` or `NODE_TLS_REJECT_UNAUTHORIZED` to the runtime, so the shell that started `delorun` cannot stand between the runtime and the connections it verifies.
- An installed runtime is made read-only before its files are hashed, so nothing can change a file between its check and the mode that protects it, and a release log entry whose signing key cannot be read says why in its refusal.
