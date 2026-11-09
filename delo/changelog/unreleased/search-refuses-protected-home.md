---
section: Security
---

- `glob` and `grep` now refuse the Delo home the way `read` and `read_image` already do: a search over a folder that contains it no longer lists the home's files or prints their matched lines, key files included. Delo's CLI profiles turn this protection on; a session under danger-full-access still searches everywhere it reaches.
