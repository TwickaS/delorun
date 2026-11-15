---
area: Studio
section: Fixed
---

- A key that failed its test reads the same everywhere: an amber "Key did not pass its test" in Settings → Models with a **Test key** button beside Apply, "Key saved · test failed" in the setup guide, and "Your DeepSeek key did not pass its test" with **Check key** above the message box. With no key the button reads **Add a key**.
- The setup guide's primary button is **Continue** on every step except the last. On Models it reads **Connect** once a provider is ticked and **Continue without a key** when none is, the second counter is gone for a single provider, and focus lands in the key field.
- A key saved for a model route that reads a variable other than `DEEPSEEK_API_KEY` is tested under that variable, so the guide and the banner no longer say "Add a key" for it.
- **Check key** and **Add a key** above the message box open Settings → Models. They did nothing before.
