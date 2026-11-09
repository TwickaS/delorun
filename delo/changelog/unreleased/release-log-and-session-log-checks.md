---
section: Security
---

- A release whose release-log consistency proof started from a tree with an even number of entries could be reported as unverifiable and stay uninstalled; the check now accepts every proof the release log serves and refuses only one that does not reproduce both tree roots.
- The installer's release-log check now refuses a bundle that names a different manifest file than the release's own, a release version that is not a version, and a checkpoint that no listed witness has signed, even when the trusted root carries no witness requirement of its own.
- Importing a customisation archive refuses two entries whose names are the same word written in different Unicode forms, because both would land on one file.
- A damaged or hostile session log can no longer expand a single compressed frame without a limit; a frame that would grow past 64 MiB is reported as corrupt instead of exhausting memory.
- A session log that another process was migrating at the same time is accepted only when its contents decode to the same chat plus a valid append, not merely when its first bytes match.
