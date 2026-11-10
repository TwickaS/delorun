---
area: Install and update
section: Added
waits: a delorun update command; the update library has no importer and the home process starts without its update support
---

- Before an update applies, Delo works out what the new release would change in the person's profile: each plugin it would disable or remove and why, each bundle that leaves the bundle list or cannot load, and each row and Include that loads a plugin the update disables. The report marks every prediction it could not fully make from metadata it could read, so those are never counted as safe, and it shows both the CLI home's and the desktop Host's versions and update states, because the two update independently. Nothing applies until the person confirms, and `delorun update --yes` will not confirm a report that disables or removes anything or rests on metadata Delo could not read.
- Updates leave a person's profile exactly as they shaped it. Before anything changes, Delo compares the profile with the one the new version would leave and refuses, with a reason the person can act on, when it would lose a row they added, a plugin they installed from their own machine, a setting they wrote, or the bundle order they chose, or when it would put back a plugin they ejected. Nothing applies and nothing is edited before that answer.
