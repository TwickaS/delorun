---
area: Plugins
section: Fixed
---

- `delorun plugin remove <name>` works again: it failed with "Unknown option: 'ignore-scripts'" because pnpm's `remove` does not take that option. The removal still resolves the lockfile with scripts switched off.
