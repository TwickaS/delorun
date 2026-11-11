---
area: Commands
section: Added
---

- `delorun workspace full-access <folder> on` turns on full access for a folder after showing what it means and asking you to confirm at a terminal; `off` turns it off, and without a folder the command lists the folders with full access. When Delo runs, the studio counts the change at once. `delorun headless` in that folder can then run with full access.
- `delorun mcp list` shows the local MCP servers Delo is holding, what changed since you allowed each (a new server, its arguments, its working directory or its environment variables changed, or the acceptance list could not be read) and why it waits, then the server commands you allowed, the servers that use each and when you allowed it; `delorun mcp accept <server>` shows the server's command and starts it after you confirm at a terminal, and `delorun mcp decline <server>` keeps it stopped.
- `delorun mcp revoke <command>` shows an allowed command and the servers that use it, and after you confirm at a terminal withdraws it and stops those servers; each asks you again before it next starts.
