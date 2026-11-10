---
area: Install and update
section: Added
---

- Delo tells you when a newer release exists: once a day, and at start when a day has passed, it checks your release channel's signed files and, when a newer release is out, prints one line in the terminal and shows a quiet notice in the studio's sidebar with the new version, whether it is a security fix, how many of your plugins it would turn off, and the command to run. Nothing is downloaded or installed until you run `delorun update`, and you can dismiss the notice for that version.
- The check sends nothing about you or your plugins; the release hosts see your computer's address. Turn it off in Settings → Privacy, and run it yourself any time with `delorun update --check`.
