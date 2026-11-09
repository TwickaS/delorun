---
section: Fixed
---

- The launcher starts a runtime only when the release root this home stored is one it ships, so a swapped root can no longer make an unrelated runtime look signed.
- `--release` is refused with both versions named instead of being ignored when a runtime is already installed, and `--` ends the launcher's own options so the runtime keeps its own `--release` and `--profile`.
- A runtime starts without the `NODE_OPTIONS`, `NODE_PATH`, `LD_*` and `DYLD_*` variables the shell passed in, and a profile name that would leave the Delo home is refused before anything is read.
- An install whose download fills the disk stops with the launcher's own refusal message instead of a raw file-system error.
