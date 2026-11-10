---
area: Commands
section: Added
---

- `delorun recover` shows where your profile stands and offers the way back: roll back to the last saved snapshot of the profile, or restore any earlier saved version. Both list the plugins, build approvals and version exemptions they bring back before anything is written, and a plugin version that has been revoked comes back turned off, with the reason shown.
- `delorun recover --safe-mode` makes the next start leave out the third-party bundles and the rows that load them, so a plugin that cannot start no longer keeps the home from opening. The profile itself is untouched, with every row, setting and ejected plugin still there, and `delorun recover --exit-safe-mode` loads all of it again.
