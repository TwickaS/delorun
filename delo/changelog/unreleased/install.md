---
area: Install and update
section: Added
---

- Installing Delo with `npx delorun` downloads the release it publishes, checks every file against the signed manifest and the public release log, and refuses to install anything that does not match. The runtime it installs is kept and reused, so starting Delo again needs no network.
- `--release` is refused, with both versions named, when a runtime is already installed, instead of being ignored. `--` ends the launcher's own options, so the runtime keeps its own `--release` and `--profile`.
- An install whose download fills the disk stops with the launcher's own message instead of a raw file-system error.
- Installing Delo with `npx delorun` now prints one line for each step it takes: which release it found, that the signature checked out, whether the public release log agreed, the size of the download, and the install itself. If the release log or its witness cannot be reached, has not cosigned the log's latest checkpoint, or only cosigned it long ago, the install says why, warns that the release has not been checked against the log, goes on with the release's signature, and checks again at the next connection. A log or witness that answers and disagrees with the release, or whose cosignature does not verify, still stops the install.
- Running `npx delorun` on a Node older than the one Delo needs now stops at once with one line that names the version Delo needs and where to get it, instead of failing with an error from inside the program.
- When the installed Delo fails its start check because its files changed, the launcher says so in one line and, if the version before your last update is still installed and intact, starts that version's `delorun recover rollback` to take you back; otherwise it stops with the reason as before.
