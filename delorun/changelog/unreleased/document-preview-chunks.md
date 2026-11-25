---
area: Studio
section: Fixed
---

- The spreadsheet and PDF previews open again. #108 gave both chunks one shared Worker-URL helper, and the bundler lifted it into a sibling chunk that each one required synchronously; the client module loader cannot answer a synchronous sibling request, so both panes failed to load. The main bundle now supplies the helper through the registration's inject face, so each lazy chunk stays self-contained.
