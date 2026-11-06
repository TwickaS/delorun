---
section: Added
---

- `delorun setup` asks its questions in a terminal: the model key, where commands run, the Delo additions to the studio, and whether to turn on DeepSeek's session-log upload or desktop analytics. Both upstream opt-ins default to off, and setup states that Delo has no telemetry of its own.
- `delorun setup --yes` applies every default and reads the model key from `DEEPSEEK_API_KEY`; `delorun setup --config <file>` applies an answers document. Neither form turns on reach, credential forwarding or an upstream opt-in.
- An interrupted setup resumes at the step it did not finish, and a finished setup is left unchanged.
