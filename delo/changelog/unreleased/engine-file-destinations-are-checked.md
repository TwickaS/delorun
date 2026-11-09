---
section: Security
---

- A container can no longer reach a host file by giving the mount one of the engine's own fixed paths. A mount whose destination is `/etc/hosts`, `/etc/hostname` or `/etc/resolv.conf` is now checked like any other mount unless it is really the engine's copy, so a mount of the Delo home, a Docker socket or a system folder there is refused before the workspace starts.
