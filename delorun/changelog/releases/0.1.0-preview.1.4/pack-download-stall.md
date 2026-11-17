---
area: Plugins
section: Fixed
---

- Adding a large plugin pack, such as Claude Code, no longer fails after about a minute with "This operation was aborted". A download now fails only when it receives no data for a set time (`stallSeconds`, 60 by default in the packs plugin), not when it takes long in total, and a failure names the address and the reason in the home log. The progress reports of a download no longer rewrite and re-verify the install list at every piece, which kept the studio busy and unresponsive during a download. The Agents step leaves "Adding…" with the reason when the download fails, and Retry starts it again.
