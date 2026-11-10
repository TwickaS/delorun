---
area: Chats and workspaces
section: Security
waits: the workspace supervisor launched by delorun start (it starts with no supervisor today) and a shipped profile that loads the workspaces plugin
---

- A workspace container must show, from inside, that it is confined to the workspace: your home folder, Delo's own folder and Docker's socket stay out of reach, the workspace folder is the only place it can write on your machine, and it runs with the memory, process and CPU limits it was given. A workspace whose container cannot show this, or whose check cannot be confirmed, is stopped and removed, and the workspace reports as failed instead of running commands in it.
- A workspace's container cannot reach services running on your machine through its own network: the network is created without a gateway address on the computer for the container to connect to, and a machine where that cannot be enforced does not offer the container shape instead of running workspaces it cannot separate from itself.
- The folder the coding helper keeps its connections in is mounted read-only into the container, with one writable subfolder below it for the helper's own sockets and nothing else; anything else found in that subfolder stops the workspace from starting, so a workspace cannot use it as storage or replace what the helper offers.
- A container cannot reach a host file by giving a mount one of the engine's own fixed paths. A mount whose destination is `/etc/hosts`, `/etc/hostname` or `/etc/resolv.conf` is checked like any other mount unless it is really the engine's copy, so a mount of the Delo home, a Docker socket or a system folder there is refused before the workspace starts. A workspace container is also refused when the engine reports that one of those standard files is really a mount of another host path.
