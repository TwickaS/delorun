---
area: Plugins
section: Fixed
---

- The Claude Code and Codex packs now load once added; in 0.1.0-preview.1.5 they installed but failed to load with "Cannot find package", because the copy Changes reviews left out the Delorun packages they share with the running release. Each pack's package.json now names every package the pack links, and a release is no longer built when the reviewed copy of a pack would miss one.
