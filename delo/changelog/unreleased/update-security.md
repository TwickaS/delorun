---
area: Install and update
section: Security
---

- `delorun update` never moves to a release lower than the one running: a channel or a request that names a lower release is refused before anything is downloaded, and `delorun recover rollback` stays the only way back.
- The update report says when the release log could not be reached as the release was installed, instead of showing its log check as passed, and `delorun update --yes` does not confirm such a release.
