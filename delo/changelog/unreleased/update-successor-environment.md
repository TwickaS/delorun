---
area: Commands
section: Security
---

- The release an update starts no longer inherits variables that load code into Node, its loader or OpenSSL, such as `NODE_OPTIONS` or `LD_PRELOAD`, even when a `.env` file set them for the running release; the launcher already dropped them from every start.
