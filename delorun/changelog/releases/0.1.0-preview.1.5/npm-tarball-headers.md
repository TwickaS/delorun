---
area: Plugins
section: Fixed
---

- Adding Claude Code or Codex no longer fails while unpacking with "tar header uid is not an octal number". The reader now accepts the tar headers that `npm publish` writes (empty owner fields, space-padded numbers). It still checks each file's size, mode, type and path, and applies no owner or time from the archive.
