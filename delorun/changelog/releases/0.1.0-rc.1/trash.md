---
area: Chats and workspaces
section: Added
---

- Deleting a chat or a workspace now moves it to the trash: "Move to trash" in a chat's or a workspace's menu archives its chats, stops their running work and takes them out of the sidebar. The new Trash section in Settings lists what was deleted with the days each item has left, restores an item where it was, and deletes one or every item forever from every place Delorun keeps it, with an offer to clear the operational logs at once. Items older than 30 days are deleted when Delorun starts. `delorun trash list`, `restore`, `purge` and `empty` do the same from the terminal while Delorun is stopped.
- Trash deletes a chat or a workspace into a 30-day retention, restores it before the retention ends, and purges it from every store that holds its content: the full-text index, the session generations, the attachments, the spill files and the browser drafts. It offers to clear the affected process logs, current and rotated, at once.
- Permanently deleting a chat also removes the copy the session list keeps for it, so the chat's title, first message, plan, goal and todos no longer stay on disk after the purge.
