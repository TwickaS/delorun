---
section: Added
---

- Safe mode now really starts Delo: after `delorun recover --safe-mode`, the next start leaves out the third-party bundles and the rows that load them, so a plugin that cannot start no longer keeps the home from opening. The profile itself is untouched — every row, setting and plugin you ejected is still there — and `delorun recover --exit-safe-mode` loads all of it again.
