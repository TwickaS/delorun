---
area: Commands
section: Changed
---

- `delorun headless` without the API key its model needs (DeepSeek's unless the profile selects another provider) stops at once and says which variable to set or run `delorun setup key`, instead of linking the profile first and ending in a provider error. Its progress line goes to standard error, so standard output holds only the answer, and `delorun headless --help` no longer touches the profile.
