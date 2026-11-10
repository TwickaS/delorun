---
area: Install and update
section: Added
---

- `delorun verify` checks the installed release: its files against the signed manifest, the manifest's signature and timestamp, and the release's entry in the public transparency log, in a tree the log and a witness both signed. It trusts only the release root the launcher shipped and the roots an install walked from it, prints one line per check with a summary that says it is not a full verification of Delo, and exits 1 when a check fails or the release signature could not be confirmed for a reason other than an unreachable log. `--json` prints the same report for a machine, and `--offline` skips the log.
- The installer, the launcher's start and `delorun verify` run one release-log check and keep one record of the newest log checkpoint they verified. A log that cannot be reached, answers with an error or is not signed by the log's key leaves the release unchecked and never stops a start; a log that is signed and then contradicts an earlier checkpoint, serves a broken proof or carries an invalid witness signature stops the start and names `delorun verify`. The check gives up after 90 seconds, and a running Delo retries an unchecked release every 15 minutes.
- A checkpoint stored by an earlier install is kept as the rollback floor only when the log proves it a prefix of its latest checkpoint; otherwise it is replaced, and the check says so instead of resetting the floor silently. `delorun verify` says since when a release has stayed unchecked.
