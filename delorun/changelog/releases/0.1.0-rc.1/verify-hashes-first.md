---
area: Commands
section: Security
---

- `delorun verify` hashes every runtime file before its own code runs, whatever the start check's record says, and then checks every file again. The record has no key, so a program running as you can rewrite it to hide a changed file, the runtime's Node and `delorun` itself included, from ordinary starts until the next full check, which comes at least every 7 days; `delorun verify` still finds it.
