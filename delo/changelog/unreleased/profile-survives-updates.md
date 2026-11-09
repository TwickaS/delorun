---
section: Added
---

- Updates now leave a person's profile exactly as they shaped it. Before anything changes, Delo compares the profile with the one the new version would leave and refuses, with a reason the person can act on, when it would lose a row they added, a plugin they installed from their own machine, a setting they wrote, or the bundle order they chose, or when it would put back a plugin they ejected. Nothing applies and nothing is edited before that answer.
- `delorun recover` shows where a profile stands after an update and offers the way back: the snapshot the update took, any earlier version of the profile, and a safe mode that starts without third-party plugins while leaving every row, setting and ejection in place. Undo and restore list the plugins, build approvals and version exemptions they bring back before anything is written, and a plugin version that has been revoked comes back turned off, with the reason shown.
