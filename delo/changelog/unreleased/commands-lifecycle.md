---
area: Commands
section: Added
---

- `delorun start` starts Delo in the background, so you can close the terminal, and waits until it is running; `delorun start --foreground` runs it in your terminal. `delorun` on its own does the same and opens the studio, then prints the studio's address and how to see, follow and stop Delo; if you chose during setup not to run Delo in the background, or pass `--foreground`, it runs in your terminal.
- `delorun stop` stops Delo once running chats end, or at once with `--now`.
- `delorun status` shows the home and profile in use, whether Delo is running, its process, runtime version and running chats, or prints them as JSON with `--json`.
- `delorun plugin` and `delorun headless` work as their `dsh` counterparts do, inside your Delo home; an installed Delo runs plugin operations with the pnpm it carries, so you do not need pnpm on your computer.
- When a `delorun` command or the launcher stops on a failure, it says what Delo did, why, with the error's code and the file or detail concerned, and what you can do next, naming your `--profile`; it never prints a stack trace.
