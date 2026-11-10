---
section: Added
---

- Installing Delo with `npx delorun` now prints one line for each step it takes: which release it found, that the signature checked out, whether the public release log agreed, the size of the download, and the install itself. If the release log or its witness cannot be reached, has not cosigned the log's latest checkpoint, or only cosigned it long ago, the install says why, warns that the release has not been checked against the log, goes on with the release's signature, and checks again at the next connection. A log or witness that answers and disagrees with the release, or whose cosignature does not verify, still stops the install.
