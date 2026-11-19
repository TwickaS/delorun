---
area: Safety and privacy
section: Fixed
---

- When Browser's output folder would sit inside a folder the chat can write, for example when the workspace is your home folder, a new chat starts normally with Browser off, instead of every new chat failing. Browser says why: "Browser is off in this chat: its output folder would sit inside a folder this chat can write. Use a workspace that isn't your home folder." Browser still never writes to a folder the chat's sandbox can write, and it stays off whenever that check cannot be made.
