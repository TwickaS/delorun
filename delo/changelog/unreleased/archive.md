---
area: Chats and workspaces
section: Added
---

- `delorun export <chat-or-workspace> --out <file>` writes a chat, or a workspace with its chats and their attachments, as an archive signed by your home. It warns about secrets it finds in the chat history, naming each by kind and never by value, and writes nothing until you confirm.
- `delorun import <file>` checks the whole archive before it writes anything, shows who signed it and what it holds, and imports it after you confirm. An archive whose signature does not verify, whose bytes disagree with its manifest, whose paths leave the destination, that holds a link, or that is past its size or compression limits is refused; an archive from a home you do not know is imported only after you type its key's fingerprint, and an unsigned one only after you accept it unverified. Imported chats are kept apart and stay out of every model request.
- Importing an archive brings a person's exported chats, attachments and workspaces into the home in one step that writes nothing until the whole archive has been checked: a path that climbs out of the destination, an absolute path, a link, a device, an archive past its size or compression limits and an archive whose bytes disagree with its manifest are all refused before anything is staged. The import states whether the archive's signature is verified, and shows the customisation the archive carries as a diff before any row is applied; an export warns about the secrets it finds in chat history before it writes the file.
- An archive that hides a configuration expression behind JSON escapes is refused, so a customisation value that reads as a tagged expression is caught after it is decoded as well as in the file's raw text.
- An archive with two entries whose names are the same word written in different Unicode forms is refused, because both would land on one file.
