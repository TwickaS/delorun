---
area: Install and update
section: Security
---

- Each start checks the installed release under the newest release root the launcher ships, never an older root the home stored, so a signing key a newer root revoked stops the start.
- A start stops when the release-log bundle kept beside an installed release is missing, instead of starting with a warning, and `delorun verify` fails on it as before.
