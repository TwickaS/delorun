---
area: Install and update
section: Added
---

- `delorun update` lists each change you made to Delo itself and says whether it carries over to the new release. A change carries when the new release left that file alone or changed it without touching your lines; when the two overlap, the new release's file runs and yours is kept beside it as `<file>.mine` in your copy of the new release, and `--yes` does not confirm such an update. An update refuses while changes to Delo itself wait for your review, and going back to the previous release runs your changes to it again.
