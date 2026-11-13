---
area: Setup
section: Added
---

- `delorun setup` asks the model provider with its key and how careful prompts should be, and its More settings choice asks whether Delorun keeps running in the background and the profile's name and port. A typed key is checked with one live request to the provider before it is stored, and a failed check says why and lets you enter the key again or continue. Every question can return to the one before it, and a review screen lists the answers before anything is written.
- "Ask me first" and "Ask less (like DeepSeek Harness)" take effect: they set Delo's consent and permission defaults to their Delo or stock values in the new profile.
- `delorun setup <section>` runs one section again, and `delorun setup --list` lists them.
- A terminal setup ends by printing the next steps and starts nothing; `delorun` starts Delorun in the background, which keeps running after the terminal closes, with the commands `delorun status`, `delorun logs --follow` and `delorun stop`.
- `delorun setup --yes` applies every default; `delorun setup --config <file>` applies an answers document. Neither form turns on reach or credential forwarding, and `--check-key` checks the key with one live request.
- `delorun setup` does not ask about the two upstream opt-ins, desktop analytics and DeepSeek's session-log upload. Both stay off, and Settings → Privacy changes them.
- An interrupted setup resumes at the step it did not finish, and a finished setup is left unchanged.
- Setup from a source checkout adds Delo's bundle to the new profile, so the Privacy section in Settings loads on the first start without a manual step.
