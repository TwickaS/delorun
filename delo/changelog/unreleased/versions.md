---
area: Compatibility
section: Added
---

- `delorun --version` prints which Delo this is and which DeepSeek Harness it runs on, one line each, and `--json` prints the same two as one line for scripts.
- A plugin can say which Delo versions it works with, and Delo honours it: a plugin that asks for a newer Delo than the one you run is refused at install and disabled at start, and the message tells you which Delo you have and which DeepSeek Harness it runs on. A plugin that asks for nothing behaves exactly as before.
- Settings names Delo's version and, beneath it, the DeepSeek Harness version it runs on.
