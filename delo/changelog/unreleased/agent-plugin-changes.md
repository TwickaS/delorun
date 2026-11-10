---
area: Safety and privacy
section: Added
---

- Before the agent first writes to the folder of a plugin you approved, the chat asks you, names the plugin and shows the diff, because the agent is changing what your harness runs; once you allow it, the rest of that chat's writes to the plugin go ahead, and what it wrote still waits for your review in `delorun changes`. A link or a `..` in the path asks the same way.
- When the agent asks to install, update or remove a plugin, nothing is installed or removed: the request waits in `delorun changes` for you to apply or discard it at your computer, and the agent is told so. Applying a plugin from a folder adds it with nothing loaded, and its content waits for your review as its own change.
