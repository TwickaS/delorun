---
area: Setup
section: Changed
---

- Each agent on the setup step (Claude Code and Codex) now says how a chat uses it, carries a use-at-your-own-risk warning, and adds with one press and no second confirmation. Claude Code also recommends running it from your home internet connection, not a VPN, proxy or cloud server. Delorun still asks at your computer the first time a chat hands an agent a task in a workspace.
- Each agent card now has Advanced options, closed by default, with the model and the time limit per task. A new guide page, [Hand work to Claude Code or Codex](https://docs.delorun.com/guide/agents), explains how a chat uses an agent.
- Each card shows how much adding the agent downloads. When the agent is not signed in, the card shows `delorun agents login claude-code` or `delorun agents login codex` with a Copy button; the command runs the agent's own sign-in, so you need no separately installed command.
- The model choice lists the models an added agent reports, with the agent's own default first. Before the agent is added, only the default shows.
