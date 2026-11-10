---
area: Safety and privacy
section: Security
---

- The sandbox keeps confined commands from reading or writing Delo's home and from connecting to the sockets of Delo's own services and of Docker, where the platform enforces it. A writable workspace that contains the home is refused for commands, and the file tools refuse to read, search or write inside it. A key file there stays out of reach of a command the agent runs.
- Searching the machine with `glob` or `grep` no longer reaches Delo's home: a search over a folder that contains it lists none of the home's files and prints none of their matched lines, so a pattern or a word that matched a key file there finds nothing. A session under full access still searches everywhere it reaches.
- The model can no longer offer you a file from Delo's home as a deliverable: presenting a file inside the home, or through a link that leads into it, is refused before the file is looked at, as opening it already was. A session under full access can still present any file it reaches.
- The sandbox records which of these rules each platform cannot enforce: Linux cannot block socket connections, and Windows does not limit reads.
- The Linux sandbox launcher refuses a grant path that names a symbolic link in any part and does not run the command, so a path swapped for a link after it was checked cannot widen what a command may touch.
- Under WSL, a command the agent runs in the sandbox can no longer start a Windows program through WSL's interop, by its path, by name or as a copy. Where the sandbox cannot use bubblewrap, its fallback cannot block this, so it refuses to run commands under WSL rather than leave this way out open.
