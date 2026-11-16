---
area: Commands
section: Added
---

- `delorun setup export --out <file>` writes the plugins you added, your model choices and your settings as one signed file, with the files of the plugins you made yourself. It carries no key, chat, device or answer of setup. `delorun setup import <file>` shows who signed the file (or that nobody can be shown to have), lists everything it would add, replace, remove or take back to its default, asks, and then replaces your profile's setup through the same plugin checks and code review as installing the plugins by hand. It saves your setup first, so one restore from Settings → Setup versions or `delorun recover restore` undoes the import. Settings → Setup versions has an Export setup and an Import setup button that do the same at your computer.
