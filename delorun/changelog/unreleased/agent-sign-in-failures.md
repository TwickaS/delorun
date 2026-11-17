---
area: Agents
section: Changed
---

- The Agents step now says "Sign-in found on this computer" for Claude Code and Codex, because a sign-in file on disk cannot prove the sign-in still works.
- When Claude Code or Codex fails because it is not signed in or its sign-in has expired, the chat says so and names the command to run (`delorun agents login codex` or `delorun agents login claude-code`). The model is told not to retry until you have signed in again, so you are no longer asked to consent a second time.
