---
section: Added
---

- The `delorun` command keeps your data in your own Delo home, `~/.delo` or the directory `DELO_HOME` names, readable only by you, and never touches DeepSeek Harness's `~/.dsh`. Its first run sets up the command-line profile; after that it starts Delo in your terminal and opens the studio. Only one Delo runs per profile.
- `delorun status` shows the home and profile in use and whether Delo is running; `delorun plugin` and `delorun headless` work as their `dsh` counterparts do, inside your Delo home.
