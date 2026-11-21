---
area: Commands
section: Fixed
---

- Pressing Ctrl-C, or sending a stop signal, to the `delorun` command ends Delorun the way the program itself ends: the launcher passes the signal on, waits for the program to finish, and exits with its status, so the program no longer keeps running in your terminal after the prompt returns.
