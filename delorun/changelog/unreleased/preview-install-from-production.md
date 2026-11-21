---
area: Install and update
section: Changed
---

- Until `1.0.0`, a release that the maintainer built and signed on the maintainer's PC installs from the release channel at releases.delorun.com, so `npx delorun` installs it. Nothing rebuilds such a release independently, and the trust page says so. A `1.0.0` release, or a release under a later signing root, that was built this way is refused.
