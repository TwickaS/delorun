---
area: Commands
section: Changed
---

- Each `delorun` command now loads only the code it needs, so `delorun --version` and `delorun --help` answer in a fraction of the time they took, and `status`, `logs`, `trash` and the other short commands start sooner too. What the commands print and the exit codes are the same.
