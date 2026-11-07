---
section: Added
---

- `delorun start` starts Delo in the background, so you can close the terminal, and waits until it is running; `delorun start --foreground` still runs it in your terminal. `delorun stop` stops it once running chats end, or at once with `--now`, and `delorun status` shows its state, process, runtime version and running chats, or prints them as JSON with `--json`.
- Commands reach a running Delo through a socket in your Delo home that accepts only the key Delo writes there each time it starts. Delo turns on the sandbox's protection of your Delo home for its own profile, so a command the agent runs in the sandbox cannot read your Delo home or that key, or connect to that socket, where the platform enforces it.
