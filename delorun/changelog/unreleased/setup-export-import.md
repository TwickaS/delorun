---
area: Commands
section: Added
---

- `delorun setup export --out <file>` writes the plugins you added, your model choices and your settings as one signed file, with the files of the plugins you made yourself. It carries no key, chat, device or answer of setup. `delorun setup import <file>` shows who signed the file (or that nobody can be shown to have), lists everything it would add, replace, remove or take back to its default, asks, and then replaces your profile's model choices, your other settings and the plugins the file lists through the same plugin checks and code review as installing the plugins by hand. It saves your setup first, so one restore from Settings → Setup versions or `delorun recover restore` undoes the import. Settings → Setup versions has an Export setup and an Import setup button that do the same at your computer.
- You choose what goes in and what comes out: `--no-settings` leaves your settings out of the file or alone on import, `--plugin <name>` puts in only the plugins you name, `--no-local-code` names your own plugins without their code, `--note` adds a note the importer reads, and `--remove-others` also removes the plugins the file does not list (by default an import touches only the plugins the file lists). The studio dialogs have the same choices as switches and a checklist.
