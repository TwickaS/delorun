---
area: Plugins
section: Fixed
---

- Adding Browser, Webhooks or another optional plugin from the setup guide or Plugins now loads it; in 0.1.0-preview.1.3 the download finished but the plugin could not load (`management-required` or `operation-error`).
- A paired phone, even unlocked, cannot change the address or port the GitHub webhook endpoint listens on; only the computer can.
