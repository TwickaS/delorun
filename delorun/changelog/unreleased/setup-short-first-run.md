---
area: Setup
section: Changed
replaces: setup-by-use-case.md
---

- `delorun setup` is short: one privacy line, then "Use Delorun from your phone too?", then, only if you have DeepSeek Harness chats, whether to copy them, and then it starts Delorun and opens the studio. The studio's welcome screen asks for your model key. The "How will you use Delorun?" question and the review screen are gone.
- Setup picks the studio port itself: it takes 3080, or the next free port and says so. How much Delorun asks, running in the background, the profile name and phone access are in Settings → General → How Delorun runs, each with the `delorun setup` command that changes it.
- The first start runs in the terminal; Ctrl+C stops it, and `delorun start --background` keeps it running after the terminal closes. Setup ends by asking whether to keep the `delorun` command.
- A run without a terminal, or with `--yes`, asks nothing and takes safe defaults. `--phone` turns on phone access, `--import-dsh` copies your DeepSeek Harness chats, and `--port <n>` sets the studio port.
