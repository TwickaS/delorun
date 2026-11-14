---
area: Chats and workspaces
section: Fixed
---

- A damaged workspace list no longer leaves the studio empty. Delorun starts with every workspace record it can read, sets the rest aside in a dated file next to the list (it never deletes one), and logs where it is. It also keeps the previous good copy of the list, `delorun doctor` checks the list, and `delorun recover workspaces` brings the previous copy back after asking you. See [The workspace list](../../docs/guide/troubleshooting.md#the-workspace-list).
- The agent can rename a workspace with the new `rename_workspace` tool, after you allow it, instead of editing files by hand.
