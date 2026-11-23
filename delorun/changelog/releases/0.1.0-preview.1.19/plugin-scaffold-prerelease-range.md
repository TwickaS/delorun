---
area: Plugins
section: Fixed
---

- `delorun plugin new` now writes `engines.delorun` as `^0.1.0-0`, so `delorun plugin check` and the installer admit the plugin on a prerelease such as 0.1.0-preview.2.6 as well as on the final release, and `--dir` creates missing parent folders such as `plugins/home`.
