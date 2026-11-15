---
area: Commands
section: Added
---

- `delorun doctor` checks Docker, the format of the key of the provider new chats start on, the Delorun home's permissions and whether the studio's port is free, and says whether the running release was checked against the release log: verified, refused, or unchecked with how long it has been and why, and what the last check for a newer release found. It sends nothing to the provider and starts no container.
- `delorun doctor` checks the port the profile's studio uses, and a port held by this home's own Delorun is reported as in use by Delorun, not as a failure.
- On Linux, `delorun doctor` checks whether bubblewrap can sandbox commands. Where it cannot, every sandboxed command is refused on a machine with a login session; the line says why, and where Ubuntu's AppArmor restriction on user namespaces blocks it, points to how to allow bubblewrap alone.
- `delorun doctor` accepts a studio port of 0, which asks the system for a free port at each start, and prints no YAML warning for a profile that holds a `!!js` expression.
- `delorun doctor` checks Docker, the DeepSeek API key's format, the Delorun home's permissions and whether the studio's port is free, and says whether the running release was checked against the release log: verified, refused, or unchecked with how long it has been and why, and what the last check for a newer release found. It sends nothing to DeepSeek and starts no container.
- `delorun doctor` checks your plugins: it lists what is installed in your profile, where each plugin came from and whether it is turned on, and warns or fails when a plugin needs another Delorun or DeepSeek Harness version, is hidden by a plugin Delorun ships under the same name, is turned on but not installed, did not load at the last start, or is left out because Delorun is in safe mode. It reads files only and runs no plugin code.
