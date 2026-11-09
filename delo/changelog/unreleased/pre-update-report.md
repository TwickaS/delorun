---
section: Added
---

- Before an update applies, Delo now works out what the new release would change in the person's profile: each plugin it would disable or remove and why, each bundle that leaves the bundle list or cannot load, and each row and Include that loads a plugin the update disables. The report marks every prediction it could not fully make from metadata it could read, so those are never counted as safe, and it shows both the CLI home's and the desktop Host's versions and update states, because the two update independently. Nothing applies until the person confirms, and `delorun update --yes` will not confirm a report that disables or removes anything or rests on metadata Delo could not read.
