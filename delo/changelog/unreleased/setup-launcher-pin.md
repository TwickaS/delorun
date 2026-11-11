---
area: Setup
section: Security
---

- `delorun setup` installs the `delorun` command at the exact version of the launcher you ran, `npm install -g delorun@<version>`, never whatever version npm serves as newest, and offers no install when that version is unknown. `delorun verify` prints the launcher's version with the integrity the signed release lists for it, which you compare with `npm view delorun@<version> dist.integrity` as the Trust page describes.
