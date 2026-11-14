---
area: Safety and privacy
section: Security
---

- MCP servers can no longer use a stored credential to change what a reviewed start runs. A `${credential:NAME}` in a server's command, folder or a variable that changes what runs (`PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `PYTHONPATH` and the like) is refused when the server loads, and an argument that is only a credential and would start with `-` is refused at start. The review shows templated arguments as written, with a note that they are filled from stored credentials.
