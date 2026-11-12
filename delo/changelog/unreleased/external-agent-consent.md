---
area: Safety and privacy
section: Added
---

- Before an external agent such as Claude Code or Codex runs, Delorun asks you at the home's own computer, saying that it runs outside the sandbox, can reach your files and Delorun's home, and uses your own account. A phone signed in over remote access cannot answer.
- "Allow for this workspace" on the approval card, or `delorun workspace external-agents <folder> <agent> on`, lets an agent start there without asking; Settings, Permissions and `delorun workspace external-agents <folder> <agent> off` revoke it.
- A read-only chat never starts an external agent, a run cannot start outside the chat's workspace, and each run stops after 30 minutes.
- The model can no longer install or turn on the Claude Code and Codex plugins through plugin management.
- Setup's **Same as stock** answer keeps DeepSeek Harness's behaviour.
