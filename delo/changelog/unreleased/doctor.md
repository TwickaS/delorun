---
area: Commands
section: Added
---

- `delorun doctor` checks Docker, the DeepSeek API key's format, the Delo home's permissions and whether the studio's port is free, and says whether the running release was checked against the release log: verified, refused, or unchecked with how long it has been and why, and what the last check for a newer release found. It sends nothing to DeepSeek and starts no container.
- `delorun doctor` checks your plugins: it lists what is installed in your profile, where each plugin came from and whether it is turned on, and warns or fails when a plugin needs another Delo or DeepSeek Harness version, is hidden by a plugin Delo ships under the same name, is turned on but not installed, did not load at the last start, or is left out because Delo is in safe mode. It reads files only and runs no plugin code.
