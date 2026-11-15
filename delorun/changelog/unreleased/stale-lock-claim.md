---
area: Commands
section: Added
---

- A write lock left behind by a process that was killed while taking over a dead writer's lock does not block later writers: the leftover claim is removed after ten seconds.
