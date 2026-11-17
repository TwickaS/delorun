---
area: Studio
section: Added
---

- A change to Delorun's own files now takes effect without a full stop and start. A change to the studio's own built files (its scripts, styles and images) is served at once, and a page reload shows it; chats keep running. Any other change waits for a restart.
- **Restart** in the studio's Changes section restarts Delorun on the release it runs, so the waiting changes run. It waits for running chats to finish, or stops them if you choose, and refuses new turns while it waits; you can cancel it while it waits. If the new start fails its checks, the running Delorun keeps going unchanged and the newest change to Delorun's own files is left out, with why. Restart needs the same as Apply: the computer, or under Phone powers Full a phone with an unlock you entered on it. It is refused while an update runs, and an update is refused while a restart runs.
- `restartWaitSeconds` in the Changes plugin's settings sets how long a restart waits for running chats, 10 minutes by default.
