---
area: Install and update
section: Added
waits: delorun update and the studio's Update now calling the carry check of @delorun/profile-safety before they apply an update; only the archive import calls it today
---

- Updates leave a person's profile exactly as they shaped it. Before anything changes, Delorun compares the profile with the one the new version would leave and refuses, with a reason the person can act on, when it would lose a row they added, a plugin they installed from their own machine, a setting they wrote, or the bundle order they chose, or when it would put back a plugin they ejected. Nothing applies and nothing is edited before that answer.
