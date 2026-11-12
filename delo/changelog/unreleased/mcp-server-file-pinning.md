---
area: Safety and privacy
section: Security
---

- An MCP server you allowed keeps running only the files you allowed: Delorun remembers the contents of the program it starts and of a script its arguments name, such as the `server.js` of `node server.js` or the file a `node_modules/.bin` link points to. If one of them is rewritten or a link points elsewhere, Delorun asks you again before the server starts, at startup and also when the server restarts after it stopped, and shows "A file it runs changed since you allowed it". Files the program loads by itself, such as other modules of a package, and code that `npx` or `uvx` downloads are not covered. Servers you allowed before this change ask once more.
