---
area: Safety and privacy
section: Changed
---

- Claude Code and Codex now start without a card in two cases: a chat on Full access, and `delorun headless` with setup's "Never ask (dangerous)" answer. You chose to run these without prompts, so Delorun no longer asks. Each start uses your own Claude or Codex plan, with no card and no one watching, and the agent works outside Delorun's sandbox. Before, both cases refused and told you to allow the agent for the workspace. A Full access chat shows "Started without asking · Full access" under the hand-off. Read Only chats, chats without a workspace folder and run folders outside the workspace still refuse, and a chat that asks still asks. To make these runs refuse again unless you allowed the agent for the workspace, turn off **Full access chats start agents without asking** in Settings, Safety, External agents. Only your computer turns it back on; a phone can turn it off.
