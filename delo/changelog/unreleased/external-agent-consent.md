---
area: Safety and privacy
section: Added
---

- Before an external agent such as Claude Code or Codex runs, Delorun asks you at the home's own computer, saying that it runs outside the sandbox, can reach your files and Delorun's home, and uses your own account. A phone signed in over remote access cannot answer.
- "Allow for this workspace" on the approval card, or `delorun workspace external-agents <folder> <agent> on`, lets an agent start there without asking; Settings, External agents and `delorun workspace external-agents <folder> <agent> off` revoke it.
- A read-only chat and a chat without a workspace folder never start an external agent, a run cannot start outside the chat's workspace, the question names the folder the agent runs in, and each run stops after 30 minutes. A full-access chat and `delorun headless` cannot ask, so they start an agent only where you allowed it for the workspace.
- The model can no longer install or turn on an external-agent plugin, such as Claude Code, Codex or the ACP one, through plugin management.
- Settings, External agents has its own switch, **Ask before external agents run**, on by default, and the run time limit, from 1 to 1440 minutes. Setup's prompts answer does not change either, and only the home's own computer can turn the question off.
