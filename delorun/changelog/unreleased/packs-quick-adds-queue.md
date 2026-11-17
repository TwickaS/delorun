---
area: Plugins
section: Fixed
---

- Adding several plugins in quick succession no longer takes minutes or fails. Delorun no longer watches the files of its own signed plugin packs for edits, so a pack install and a restart do not queue behind each other. A second Add waits for the first instead of failing with "STORE_BUSY", the setup guide's Try again sends the request again, and a failed add says so in plain words without file paths or process numbers.

- The downloads panel and the setup guide's plugin rows follow an install promptly. Delorun used to read and check every file of every installed plugin pack at each progress report; it now checks a pack once every 30 seconds (`verifyCacheMs` in the packs plugin) and again when its install ends.

- The "plugins added" panel no longer comes back at every page load or restart and covers the message box; it shows only for installs you watched. Pack rows in the setup guide describe themselves before they are added, use one name throughout, and "Adding…" no longer shifts when its progress bar appears.
