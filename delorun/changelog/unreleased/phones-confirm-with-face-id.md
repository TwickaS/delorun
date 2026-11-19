---
area: Safety and privacy
section: Added
---

- Phones confirm sensitive actions with Face ID, or with the device lock where there is no Face ID, and set it up when pairing or in Settings, Devices. It is on for every home, with no preview switch to turn on; a home that had set the old `unlock.passkeys` preview switch keeps its other preview switches, and the retired one is ignored with a line in the log. A phone with no passkey confirms with its PIN. Every sensitive action on a phone asks once, at the moment you take it, in plain words such as "Install a plugin", "Open a terminal" or "Save a model key": installs, full access, network settings, MCP servers, external agents, the terminal, the folder picker, new workspaces, settings changes, model keys, Changes and updates. A terminal asks once, when it opens, and the folder picker asks once while it stays open. Cancel sends nothing, and the action shows that it was not confirmed. Your computer never asks. Phone powers is gone, so there is no level to choose.
