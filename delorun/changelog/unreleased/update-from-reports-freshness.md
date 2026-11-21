---
area: Install and update
section: Fixed
---

- The update report no longer says the release's freshness passed when it was never checked. A release installed with `delorun update --from` after you agreed that the release channel cannot confirm it is current now shows "freshness unchecked". `delorun update --yes` does not confirm it, and the studio asks you to tick that you want to update anyway, as it does when the release log could not be reached.
