---
area: Commands
section: Changed
---

- On a full-size runtime the launcher's start check takes under a second, because it compares each file with what it recorded after the file was last hashed, and hashes only the files that changed since. It still hashes every file at install, on `delorun verify`, and at least every 7 days; `DELORUN_RUNTIME_FULL_CHECK_DAYS` sets that interval from 0, every start, to 30 days. Disk corruption that leaves a file's metadata alone is found by that full check, not by the next start. On macOS, Windows, overlay file systems such as a container's, and network or other file systems whose timestamps the computer does not set itself, every start still hashes every file.
- An update hashes the new release's files as it writes them, and checks the running release before it starts and the new one before and after the switch the way every start does, so it does not read every file of the runtime a second time. An install likewise does not read back every file it has just written.
