---
area: Safety and privacy
section: Added
---

- `delorun setup prompts` offers a third answer, **Never ask (dangerous)**, for people who want Claude Code's bypass mode: any chat can then switch to full access with no question. It shows a warning, asks a yes-or-no that starts on No, and then asks you to type `full access everywhere`. A scripted setup needs `--prompts dangerous --accept-dangerous-mode`, `--yes` alone never selects it, and Delorun refuses it when it runs as root. While it is on, `delorun` at start, `delorun status` and `delorun doctor` say so, and choosing another answer turns it off.
