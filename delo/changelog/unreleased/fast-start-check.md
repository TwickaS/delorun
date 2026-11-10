---
area: Commands
section: Changed
---

- Every `delorun` command starts about 9 seconds sooner: on a full-size runtime the launcher's check takes under a second instead of about ten, because it compares each file with what it recorded after the file was last hashed, and hashes only the files that changed since. It still hashes every file at install, in an update, on `delorun verify`, and at least every 7 days; `DELO_RUNTIME_FULL_CHECK_DAYS` sets that interval from 0, every start, to 30 days. Disk corruption that leaves a file's metadata alone is found by that full check, not by the next start. On macOS, Windows, overlay file systems such as a container's, and network or other file systems whose timestamps the computer does not set itself, every start still hashes every file.
- An update hashes each runtime once instead of once for every part of its report, and an install no longer reads every file it has just written again.
