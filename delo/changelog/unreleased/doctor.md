---
area: Commands
section: Added
---

- `delorun doctor` checks Docker, the format of the key of the provider new chats start on, the Delo home's permissions and whether the studio's port is free, and says whether the running release was checked against the release log: verified, refused, or unchecked with how long it has been and why, and what the last check for a newer release found. It sends nothing to the provider and starts no container.
- `delorun doctor` checks the port the profile's studio uses, and a port held by this home's own Delo is reported as in use by Delo, not as a failure.
- On Linux, `delorun doctor` checks whether bubblewrap can sandbox commands. Where it cannot, every sandboxed command is refused on a machine with a login session; the line says why, and where Ubuntu's AppArmor restriction on user namespaces blocks it, points to how to allow bubblewrap alone.
- `delorun doctor` accepts a studio port of 0, which asks the system for a free port at each start, and prints no YAML warning for a profile that holds a `!!js` expression.
