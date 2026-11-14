---
area: Commands
section: Changed
---

- `delorun verify` lists the plugin changes you approved, by name and folder, then apart from them the changes that loaded without review, with protection off or while it was off, then everything present that you did not approve: changes waiting for your review and anything Changes does not find as it keeps it. Its summary line then never reads as a plain pass, and it exits 1 only when something is not as Changes keeps it. A run from a source checkout or a development build says there is no signed release to compare its files with.
- `delorun doctor` reports your changes: the protection setting, any plugin you are working on, and for each plugin you link from a folder whether it loaded at the last start, whether it runs the content you approved or content that loaded without review, the dsh and Delo versions it requires and whether it changes a consent, a guard or the sandbox policy. When a plugin did not load or the start failed, it names the plugin and the change to undo.
