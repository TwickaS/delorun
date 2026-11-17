---
area: Plugins
section: Changed
---

- Browser asks you to allow its playwright-mcp server once, not once for each project folder. The server now runs in one folder of the Delorun home for every chat, so the same exact command is what you allow, and switching between projects does not ask again.
- Screenshots, PDFs and other files Browser saves go into a hidden `.playwright-mcp` folder in the chat's project, and the agent gets a link to each one. Delorun creates that folder with its own `.gitignore`, so Git leaves the files out of commits; a `.playwright-mcp` folder you already have, and your project's `.gitignore`, are left as they are.
