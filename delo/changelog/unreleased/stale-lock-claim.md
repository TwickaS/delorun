---
area: Commands
section: Fixed
---

- A write lock left behind by a process that was killed while taking over a dead writer's lock no longer blocks later writers: the leftover claim is removed after ten seconds.
