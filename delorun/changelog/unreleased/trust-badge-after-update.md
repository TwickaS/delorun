---
area: Install and update
section: Added
---

- After `delorun update` and `delorun recover rollback` the trust badge reads what was checked at start. The new release checks its own signed manifest and files when it starts after the switch, and records the result; a release that fails that check does not start, so the update rolls back as a failed health check does.
