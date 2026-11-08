---
section: Security
---

- An MCP server that would run as a local command can now be held until its command is accepted: with the add-time consent on, the exact command with its arguments is checked before the server starts, a command that has not been accepted keeps the server stopped and asks again, and an accepted command starts without asking until its arguments change. The switch is off, which changes nothing.
