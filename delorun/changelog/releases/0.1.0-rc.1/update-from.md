---
area: Install and update
section: Added
---

- `delorun update --from <folder or https address>` installs a release from files you downloaded from its release page when the release channel cannot be reached. It checks signatures, the release log and digests like a channel update. If the channel cannot confirm the release is current, it asks first in a terminal; `--yes` and a missing terminal refuse. A release below the one you run is refused. `npx delorun@latest repair --release <older> --from <folder>` asks in the same way. A repair now marks the whole home while it runs, so no Delorun starts meanwhile, not even for a new profile, and cannot run the program being set aside. A start during a repair says "Delorun is being repaired; wait for it to finish".
