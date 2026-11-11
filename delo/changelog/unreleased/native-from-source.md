---
area: Install and update
section: Security
---

- The Linux runtime's sandbox launcher and file-lock addon are compiled from the release's own tagged source in a pinned toolchain without network access, so a rebuild of the release reproduces them byte for byte, signing covers them and the release's software bill of materials names the compiler packages that built them.
