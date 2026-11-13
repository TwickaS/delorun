---
area: Commands
section: Added
---

- `delorun verify` lists what this Delo runs: the release's version, commit and digests, the trusted root and its key, the launcher that started it, when every runtime file was last hashed and what the start check did, the plugins with where each came from, your changes, the rows your patch layers add with their `!!js` count, the skill folders including `~/.agents`, and the MCP servers. `--json` carries the same list under `bill`. A part Delo cannot check yet says so instead of reading as a pass.
