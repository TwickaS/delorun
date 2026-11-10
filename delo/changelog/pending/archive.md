---
area: Chats and workspaces
section: Added
waits: export and import wired to a command or the studio; the archive library has no importer today
---

- Importing an archive brings a person's exported chats, attachments and workspaces into the home in one step that writes nothing until the whole archive has been checked: a path that climbs out of the destination, an absolute path, a link, a device, an archive past its size or compression limits and an archive whose bytes disagree with its manifest are all refused before anything is staged. The import states whether the archive's signature is verified, and shows the customisation the archive carries as a diff before any row is applied; an export warns about the secrets it finds in chat history before it writes the file.
- An archive that hides a configuration expression behind JSON escapes is refused, so a customisation value that reads as a tagged expression is caught after it is decoded as well as in the file's raw text.
- An archive with two entries whose names are the same word written in different Unicode forms is refused, because both would land on one file.
