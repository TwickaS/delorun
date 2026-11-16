---
area: Install and update
section: Added
---

- `delorun update` lists each change you made to Delorun itself and says whether it carries over to the new release. A change carries as it is when the new release left that file alone. When the new release changed the file without touching your lines, the two merge into a file neither had: `delorun update` prints its diff against the new release's file, and only you confirm it, not `--yes`. When the two overlap, the new release's file runs and yours is kept beside it as `<file>.mine` in your copy of the new release, and `--yes` does not confirm such an update either. An update refuses while changes to Delorun itself wait for your review, or when your copy of Delorun cannot be read, naming `delorun changes edit-harness --discard` and `delorun changes list`; it refuses before switching when what it would do with your changes no longer matches the report you confirmed, and asks you to run `delorun update` again. Going back to the previous release runs your changes to it again.
