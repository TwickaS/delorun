---
section: Security
---

- Spilled tool output now lives in the home's own `spill/` folder instead of the shared temporary folder, so the same rule that keeps a confined command out of your home keeps it out of your own and every other home's tools; the temporary folder is used only for a home that cannot hold it.
- The home's `.env` file is read only when it is your own file, readable by you alone, and a real file rather than a link; one that is not stops the start with the exact command that fixes it (`chmod 600 <file>`), as the credentials file already does, so another local user cannot choose what your sessions load.
- The anonymous id file is created readable by you alone, and the home directory the harness creates for it is private to you.
