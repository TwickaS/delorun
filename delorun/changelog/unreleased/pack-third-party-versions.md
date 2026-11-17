---
area: Plugins
section: Changed
---

- A plugin pack can now carry its own version of a third-party library when Delorun carries another. Delorun's own packages, the libraries that must exist once (React, Zod and the MCP SDK) and anything a pack names as a peer still have to match, so a pack built against a different copy is refused when the release is built.
