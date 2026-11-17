---
area: Install and update
section: Fixed
---

- An update no longer rolls back with "the settings of protected row delorun-reach changed" after you turned remote access on or off with `delorun reach` while Delorun was running. The running version now hands the health check the remote-access settings it applied, not the ones it started with. A new version that boots with remote-access settings other than the ones applied still fails the check unless the update report names the change.
