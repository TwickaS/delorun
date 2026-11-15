---
area: Studio
section: Added
---

- A key that failed its test reads the same everywhere: an amber "Key did not pass its test" in Settings → Models with a **Test key** button beside Apply, "Key saved · test failed" in the setup guide, and "Your DeepSeek key did not pass its test" with **Check key** above the message box. With no key the button reads **Add a key**.
- The setup guide's primary button is **Continue** on every step except the last. On Models it reads **Connect** once a provider is ticked and **Continue without a key** when none is, there is no second counter for a single provider, and focus lands in the key field.
- A key saved for a model route that reads a variable other than `DEEPSEEK_API_KEY` is tested under that variable, so the guide and the banner report that key's result and do not say "Add a key".
- **Check key** and **Add a key** above the message box open Settings → Models.
- A key test that could not finish, such as a network error, does not say the key failed: Settings → Models and the setup guide show "Could not test the key just now", and **Try again** re-runs it.
