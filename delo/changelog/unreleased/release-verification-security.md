---
area: Install and update
section: Security
---

- Each start checks the installed release under the newest release root the launcher ships, never an older root the home stored, so a signing key a newer root revoked stops the start. The launcher passes on no `DELO_LAUNCHER_` setting it inherited.
- A start stops when the release-log bundle kept beside an installed release is missing, instead of starting with a warning; the message names the missing file and offers `delorun recover rollback` or putting the file back, and `delorun verify` fails on it as before.
- A launcher that installs from Delo's published release channel refuses a release that the local release tool built.
