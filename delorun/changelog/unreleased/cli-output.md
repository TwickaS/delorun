---
area: Commands
section: Changed
---

- The terminal output reads plainly. One sentence says Delorun isn't running, an unknown command gets a single line with the closest match, a source build says it doesn't update itself, `delorun devices approve` stops at once when remote access is off, and `delorun recover status` offers only the actions that can run.
- Setup checks that the studio port is free and uses the next free one, saying which. Times read as `17 Nov 2026, 01:07`, and `delorun status` shows `source build` as the version of a source copy.
- `delorun start`, `status`, `doctor` and `update --check` mark each line (✓ done, ! needs a look, ✗ failed, ● for information), show the commands you can type next, and ring the start with a spinner on a terminal. Colour follows `NO_COLOR` and `FORCE_COLOR` and is off when the output goes to a file. `delorun doctor` ends with a count of passed, warned and failed checks.
