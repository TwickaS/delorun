---
area: Plugins
section: Changed
---

- When a plugin folder you link holds more files than Delorun copies (50,000), the refusal now says what to do: remove its development packages with `npm prune --omit=dev` in that folder, or link a folder that holds only the built plugin, then start again.
