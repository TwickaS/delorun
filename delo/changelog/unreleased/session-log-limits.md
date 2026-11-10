---
area: Safety and privacy
section: Security
---

- A damaged or hostile session log can no longer expand a single compressed frame without a limit; a frame that would grow past 64 MiB is reported as corrupt instead of exhausting memory.
- A session log that another process was migrating at the same time is accepted only when its contents decode to the same chat plus a valid append, not merely when its first bytes match.
