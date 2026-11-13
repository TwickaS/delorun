---
area: Install and update
section: Fixed
---

- `delorun recover discard runtimes.set-aside-<time>` removes the program store that `delorun repair` set aside. It stopped with a permission error because the installed program's folders are read-only.
