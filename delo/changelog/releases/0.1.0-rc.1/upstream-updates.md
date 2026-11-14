---
area: Compatibility
section: Added
---

- Delo's own changes are carried onto a newer DeepSeek Harness release by a maintainer command, which stops with a report of what no longer applies instead of dropping a change.
- Delo records a checksum for each DeepSeek Harness file it edits, so the command notices when one of those files changed underneath it and refuses to carry a change that was edited after it was recorded.
