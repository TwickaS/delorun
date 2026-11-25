---
area: Plugins
section: Fixed
---

- A plugin's Delorun requirement is checked against the Delorun that is running, and a caller that asks for the DeepSeek Harness axis alone gets only that axis. The update report decides each axis separately, so a plugin whose `engines.delorun` the target does not satisfy is now reported on the Delorun axis instead of being read as a Delorun mismatch while the Harness axis was being decided.
