---
area: Safety and privacy
section: Security
---

- Delorun checks every start against the protections it promises before anything runs, and again once the studio has started: the sandbox protects Delorun's home, Delorun's consent and guard plugins are on, and your prompts answer is the one setup recorded. A patch, your home's own `cordis.patch.yml` included, that turns one of them off or points the sandbox at its own runner stops the start with the file to fix, or `delorun recover safe-mode` to start without your plugins.
- `delorun headless` now runs its task under the same sandbox protection of Delorun's home as the studio, and refuses `--profile`, `--patch` and `--from-default-profile`.
