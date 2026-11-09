---
section: Security
---

- A workspace's container can no longer reach services running on your machine through its own network: the network is created without a gateway address on the computer for the container to connect to, and a machine where that cannot be enforced no longer offers the container shape instead of running workspaces it cannot separate from itself.
- The folder the coding helper keeps its connections in is now mounted read-only into the container, with one writable subfolder below it for the helper's own sockets and nothing else; anything else found in that subfolder stops the workspace from starting, so a workspace cannot use it as storage or replace what the helper offers.
