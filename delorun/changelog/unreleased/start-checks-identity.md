---
area: Safety and privacy
section: Security
---

- A start now checks which plugin runs each protection, not only that a row with its name is on: a patch or a plugin that adds a second sandbox row or a second copy of one of Delorun's guard rows under another plugin is refused, naming the file, safe mode never skips one of them, and once the studio has started each protection's service must come from its own plugin.
- No chat turn in the studio reaches the model until the start has checked the running studio's protections; a turn sent before that waits, and is refused if the start is refused.
- A `.env` file in the folder you run `delorun` from, or in Delorun's home, can no longer set a `DELORUN_` setting such as the launcher's release roots; Delorun refuses to start and names the file.
- When the release you updated to fails its start check, only `delorun`, `delorun start` and `delorun recover rollback`, with nothing after `--`, start the release before it to roll back; any other command, `delorun verify` and `delorun stop` included, is refused with what failed and `delorun recover rollback` as the way back, and changes nothing.
- An update checks again, right before it stops Delorun for the switch, that no other profile's Delorun or `delorun headless` started using your chats since it began, and stops without changing anything if one did.
- The profile names `headless`, `data-users`, `node_modules` and `desktop`, and the Windows device names such as `con` and `nul`, are reserved: `delorun`, `delorun plugin`, `delorun logs`, the launcher and setup refuse them and say why, and `delorun plugin` and `delorun logs` refuse a command line that names two different profiles.
- A Delorun running in another container or sandbox that shares your home now counts as running, so its home lock is never taken over as if it had stopped.
