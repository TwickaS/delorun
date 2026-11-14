---
area: Safety and privacy
section: Security
---

- A plugin's key, a setting the plugin marks as secret such as the DeepSeek API key of web search, is never saved into your profile's settings files, which the profile history keeps in git: saving one from Settings or through the agent is refused with where to put it instead, and the history saves no version that holds one, while it still lists your versions and undo and restore still work.
- If a settings file already holds such a key, the next start moves it into the credentials file and points the plugin at it, telling you which file and setting changed and never showing the key; a key Delo cannot move, because the setting has no place to name a stored key, stays and every start tells you how to move it. If an earlier Delo already saved a key in the profile history, replace it with a new one.
