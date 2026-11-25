---
area: Plugins
section: Fixed
---

- `delorun plugin remove` forgets the plugin it removed: its load copy under `changes/profiles/<profile>/active/` and the `active.json` entry that named it go, so a plugin a person installs, tries and removes leaves no copy of its files behind to load again. What Changes recorded of the plugin stays, so a change made while it was installed can still be undone, and a plugin the profile still depends on keeps its copy.
