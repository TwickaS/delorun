---
area: Safety and privacy
section: Security
---

- A model-authored write to a skill, a preset, or a workspace's `AGENTS.md` asks for an approval that names the instruction-layer effect, because these instructions load in every future chat, and shows the diff, on every permission preset including full access.
- An MCP server that would run as a local command is held until its command is accepted: the exact command with its arguments is checked before the server starts, a command that has not been accepted keeps the server stopped and asks again, and an accepted command starts without asking until its arguments change.
- Approving a scheduled task names the recurrence it arms, the chat its deliveries reach and the permission preset that chat runs under, and a due delivery refuses, pausing the task, when that chat no longer runs the preset the task was approved under. The approval also names the task, the start of its message and the chat by its title, and for a new chat the folder it opens in and the preset that chat will really start with, such as its workspace's; the task is then held to the preset you were shown. Every occurrence is checked, a task that opens a new chat is checked before the chat exists, so a refused delivery leaves no empty chat behind, and a reminder still waiting from before a restart is checked again before it runs. When the check cannot give a clear answer, nothing is delivered: an answer it does not recognise refuses, and a check that fails keeps the task waiting and reports the failure instead of delivering.
