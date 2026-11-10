---
area: Setup
section: Added
---

- `delorun setup` asks its questions in a terminal: where the DeepSeek API key comes from, whether to turn on the Delo additions to the studio, where commands run, and whether to turn on DeepSeek's session-log upload or desktop analytics. Both upstream opt-ins default to off, and setup states that Delo has no telemetry of its own.
- Setup writes the profile, stores the key and applies the session-log choice. The answers about the Delo additions, where commands run and desktop analytics are recorded; they change nothing yet.
- `delorun setup --yes` applies every default and reads the model key from `DEEPSEEK_API_KEY`; `delorun setup --config <file>` applies an answers document. Neither form turns on reach, credential forwarding or an upstream opt-in.
- An interrupted setup resumes at the step it did not finish, and a finished setup is left unchanged.
- Setup from a source checkout adds Delo's bundle to the new profile, so the Privacy section in Settings loads on the first start without a manual step.
