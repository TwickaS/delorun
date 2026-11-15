---
area: Safety and privacy
section: Security
---

- Delorun refuses to use a home folder or secret file that other users on your computer could read, and prints the `chmod` command that fixes it.
- Spilled tool output lives in the home's own `spill/` folder instead of the shared temporary folder, so the rule that keeps a confined command out of your home keeps it out of your spilled output too; the temporary folder is used only for a home that cannot hold it.
- The home's `.env` file is read only when it is your own file, readable by you alone, and a real file rather than a link; one that is not stops the start with the exact command that fixes it (`chmod 600 <file>`), as the credentials file already does, so another local user cannot choose what your sessions load.
- The anonymous id file is created readable by you alone, and the home directory the harness creates for it is private to you.
