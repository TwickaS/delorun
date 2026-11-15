---
area: Install and update
section: Fixed
---

- The trust badge now reads what was checked at start after `delorun update` and `delorun recover rollback`, not "Unknown". The new release checks its own signed manifest and files when it starts after the switch, and records the result; a release that fails that check does not start, so the update rolls back as a failed health check does.
