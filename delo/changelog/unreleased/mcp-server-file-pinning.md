---
area: Safety and privacy
section: Security
---

- An MCP server you allowed asks again before it starts if the program it runs, or a script file its arguments name, changed since you allowed it: Delorun remembers the contents of the program and of a file an argument names, such as the `server.js` of `node server.js`, the `./hook.js` of `--import=./hook.js` or the file a `node_modules/.bin` link points to. If one of them is rewritten or a link points elsewhere, Delorun asks you again before the server starts, at startup and also when the server restarts after it stopped, and shows "A file it runs changed since you allowed it". The server starts from the file the link pointed to when it was checked, and the review shows that file when the command is a link. Files the program loads by itself, such as other modules of a package, and code that `npx` or `uvx` downloads are not covered, so the review also names the folder and files of the server that your chats can write to.
