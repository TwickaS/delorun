---
area: Plugins
section: Fixed
---

- Adding several plugins in quick succession no longer takes minutes or fails. Delorun no longer watches the files of its own signed plugin packs for edits, so a pack install and a restart do not queue behind each other. A second Add waits for the first instead of failing with "STORE_BUSY", the setup guide's Try again sends the request again, and a failed add says so in plain words without file paths or process numbers.
