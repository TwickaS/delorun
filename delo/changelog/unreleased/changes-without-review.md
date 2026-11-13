---
area: Plugins
section: Added
---

- Changes protection is off by default, so you change your harness freely: a plugin you link from a folder loads your saved edits at each start and, while Delo runs, each time you save a file in its folder, without a work session. Each load is recorded as a change that loaded without review, which `delorun changes list` shows and `delorun changes undo` takes back, and content you undid does not load again until you save something else. A saved version that fails to load goes back to what ran before and is not tried again until you save again. `delorun changes protection on` makes changes wait for your review instead, and takes effect without a restart.
