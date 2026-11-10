---
area: Commands
section: Added
---

- `delorun changes` lists the changes to your plugins that wait for your review and shows each with its files, a diff and a summary of what it can do. `apply`, `discard` and `undo` decide about one change after you confirm in a terminal, with a second confirmation when the change runs commands, opens network connections or does anything else the summary names. A running Delo loads an applied change at once and goes back to what ran before when it fails to load. `off` and `on` turn one plugin off and on again, and `protection` sets whether unreviewed changes run. `work <plugin>` loads every edit you save in a plugin's folder live, going back to the last version that loaded when an edit fails to load, until `done <plugin>`, or Delo stopping, makes the folder's content the approved version as one change.
