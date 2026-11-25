---
area: Setup
section: Added
---

- `delorun setup` can make Delorun start by itself when you log in, through a systemd user unit, so the studio is there without a terminal. It sits beside the question about keeping Delorun running after the terminal closes, and it starts on No. The choice text says whether Delorun also starts when the machine boots with nobody logged in, which needs linger and which this computer may refuse. `delorun setup autostart` changes the answer later, and answering No removes the unit.
- `delorun stop` keeps Delorun stopped: the unit does not restart a home process you stopped, so it comes back when you start it again or the machine restarts.
- `delorun status` shows whether Delorun starts at login, and whether it also starts at boot.
