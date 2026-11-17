---
area: Plugins
section: Fixed
---

- The Agent hooks pack's Claude Code and Codex hooks now load once added; in 0.1.0-preview.1.4 they installed but failed to load with "Cannot find package". Each optional pack now carries or links every package its plugins use, and a release is no longer built when a pack would miss one.
