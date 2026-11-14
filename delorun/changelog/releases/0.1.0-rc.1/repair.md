---
area: Install and update
section: Added
---

- `npx delorun@latest repair` replaces a program that will not start with a verified release and keeps your chats, settings, keys, devices and trust records. It asks you first in a terminal, refuses while Delorun runs, refuses to put an older release over chats a newer release wrote, and keeps the old program in `runtimes.set-aside-<time>/`, which `delorun recover status` lists. `--restore-copy`, `--from` and `--reset-trust` cover the harder cases. Each start now records which release wrote your data in `data-format.json`.
