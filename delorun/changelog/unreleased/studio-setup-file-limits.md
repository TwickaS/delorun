---
area: Safety and privacy
section: Security
---

- The studio's setup import refuses a setup file whose contents claim far more space than a file of that size can hold, before it opens any of it. A crafted file can no longer make Delorun spend minutes and gigabytes of memory on it while your chats wait. A larger setup is still imported with `delorun setup import`, and the studio's message for a file or request that is too large now names the limit that applies.
