---
section: Changed
---

- The Linux sandbox launcher `landlock-run` (native packages 0.2.0) now refuses a grant path that names a symbolic link in any part and does not run the command, so a path swapped for a link after it was checked cannot widen what a command may touch. Programs that call the launcher directly pass resolved paths; Delo's sandbox already does.
