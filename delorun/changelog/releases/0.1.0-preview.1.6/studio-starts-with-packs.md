---
area: Plugins
section: Fixed
---

- Delorun starts again after you add an optional pack such as Browser or Webhooks; in 0.1.0-preview.1.5 the next start refused the profile, saying its plugins were not Delorun's own copy. A pack counts as Delorun's only when it loads from the signed pack the running release installed. A pack that does not load is now turned off with a reason in Plugins and home.log instead of stopping the studio, and a pack that cannot be fetched no longer blocks the start.
