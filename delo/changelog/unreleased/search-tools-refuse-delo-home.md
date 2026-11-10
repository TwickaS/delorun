---
section: Security
---

- The model's `glob` and `grep` searches no longer reach Delo's home directory in any agent preset: a search inside the home, or through a link that leads into it, is refused, and a search over a folder that contains the home leaves the home's files out, so a pattern that matched a key or token file there finds nothing. Opening the same files was already refused. A session under full access still searches everywhere it reaches.
