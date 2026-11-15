---
area: Compatibility
section: Added
---

- `delorun --version` prints which Delorun this is and which DeepSeek Harness it runs on, one line each, and `--json` prints the same two as one line for scripts.
- A plugin can say which Delorun versions it works with, and Delorun honours it: a plugin that asks for a newer Delorun than the one you run is refused at install and disabled at start, and the message tells you which Delorun you have and which DeepSeek Harness it runs on. A plugin that asks for nothing behaves exactly as before.
- Settings names Delorun's version and, beneath it, the DeepSeek Harness version it runs on.
- `delorun plugin check <folder>` tells a plugin author, without running the plugin, what its declared DeepSeek Harness and Delorun versions allow on the Delorun you run, what it leaves undeclared, and which Delorun range to declare to target this release; Delorun's documentation states what each Delorun version promises a plugin.
