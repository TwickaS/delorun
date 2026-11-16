---
area: Setup
section: Changed
---

- Each agent on the setup step (Claude Code and Codex) now says how a chat uses it, carries a use-at-your-own-risk warning, and adds with one press and no second confirmation. Claude Code also recommends running it from your home internet connection, not a VPN, proxy or cloud server. Delorun still asks at your computer the first time a chat hands an agent a task in a workspace.
- Each agent card now has Advanced options, closed by default. Recommended is what Add leaves in place; Read only makes Claude Code plan and review without changing files, and makes Codex run with a read-only sandbox. Fine-tune sets the model and the time limit per task. A new guide page, [Hand work to Claude Code or Codex](https://docs.delorun.com/guide/agents), explains how a chat uses an agent.
- Codex has a new `read-only` permission mode, which never asks and pins its sandbox to read-only.
- Each card shows how much adding the agent downloads, and the sign-in line names the command to run.
