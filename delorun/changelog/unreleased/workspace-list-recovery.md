---
area: Chats and workspaces
section: Added
---

- A damaged workspace list does not leave the studio empty. Delorun starts with every workspace record it can read, sets the rest aside in a dated file next to the list (it never deletes one), and logs where it is. It also keeps the previous good copy of the list, `delorun doctor` checks the list, and `delorun recover workspaces` brings the previous copy back after asking you. See [The workspace list](../../docs/guide/troubleshooting.md#the-workspace-list).
- The agent can rename a workspace with the new `rename_workspace` tool, after you allow it.
- When some workspace records were set aside, the studio says so above the message box, names the file and points to `delorun doctor`; you can dismiss it. A `rename_workspace` call in a chat shows the old and new name, or why it was refused.
