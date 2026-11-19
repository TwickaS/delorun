---
area: Safety and privacy
section: Fixed
---

- When Browser's output folder would sit inside a folder the chat can write, for example when the workspace is your home folder, a new chat starts normally with Browser's tools off, instead of every new chat failing. The reason is written to Delorun's log, and its advice depends on the cause: the workspace, an extra writable folder, or `XDG_CACHE_HOME`. Browser still never writes to a folder the chat's sandbox can write, and it stays off whenever the file system cannot resolve the folders to check. Any other error in that check still fails the chat's creation.
