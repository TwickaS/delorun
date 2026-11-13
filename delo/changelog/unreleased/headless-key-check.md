---
area: Commands
section: Changed
---

- `delorun headless` without a DeepSeek API key stops at once and says to set `DEEPSEEK_API_KEY` or run `delorun setup key`, instead of linking the profile first and ending in a provider error. Its progress line goes to standard error, so standard output holds only the answer, and `delorun headless --help` no longer touches the profile.
