---
section: Security
---

- A workspace container must now show, from inside, that it is confined to the workspace: your home folder, Delo's own folder and Docker's socket stay out of reach, the workspace folder is the only place it can write on your machine, and it runs with the memory, process and CPU limits it was given. A workspace whose container cannot show this — or whose check cannot be confirmed — is stopped and removed, and the workspace reports as failed instead of running commands in it.
