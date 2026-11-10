---
section: Changed
---

- `delorun recover` takes its action as a word: `status`, `rollback`, `restore <version>`, `safe-mode` and `exit-safe-mode` replace `--rollback`, `--restore`, `--safe-mode` and `--exit-safe-mode`.
- `delorun stop` and updates now wait for chats that are still answering, and a new message sent while Delo stops or updates is refused instead of starting a turn.
