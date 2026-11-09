---
section: Security
---

- Searching the machine with `glob` or `grep` no longer reaches Delo's own home directory: the model's searches now refuse it, as opening the same file already did, so a pattern or a word that matched a key file there finds nothing.
