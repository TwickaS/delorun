---
area: Plugins
section: Changed
---

- A plugin that declares `engines.delorun` is now checked on that range alone: its `engines.dsh` and DeepSeek Harness peer ranges are not checked on Delorun, at install, at start, in the update report and by `delorun plugin check`. A plugin without `engines.delorun` is checked as before, and stock DeepSeek Harness ignores `engines.delorun`, so one package can declare both and run on both. `delorun plugin check` says which range decided, and `--json` prints that as one record for tools.
