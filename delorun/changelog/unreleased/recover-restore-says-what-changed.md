---
area: Install and update
section: Fixed
---

- `delorun recover restore` and `rollback` no longer say "Your rows and settings are unchanged" when the restore changed your profile's `cordis.patch.yml`. They say whether your rows and settings now match that version or already did, and say nothing when the file could not be read.
