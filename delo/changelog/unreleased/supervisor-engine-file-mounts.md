---
section: Security
---

- A workspace container is now refused when the engine reports that one of its standard files (`/etc/hosts`, `/etc/hostname` or `/etc/resolv.conf`) is really a mount of another host path, such as Delo's home directory or the machine's Docker socket; the engine's own copies of those files are still accepted.
