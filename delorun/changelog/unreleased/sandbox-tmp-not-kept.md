---
area: Chats and workspaces
section: Fixed
---

- The agent now knows that a file it writes to `/tmp` while a command runs in the sandbox does not persist: each sandboxed command can have its own `/tmp`, discarded when the command ends. Before, it could report a file in `/tmp` as saved when no later command could see it. The agent is told to keep files it needs under the workspace.
