---
area: Safety and privacy
section: Security
---

- `delorun setup` stores the model key through a new file that only you can read and that replaces the credentials file in one step, while it holds the same lock as the studio's own writes to that file; a left-over or planted temporary file never receives the key, and an interrupted write leaves the credentials file as it was.
