---
area: Safety and privacy
section: Security
---

- A task run with `delorun headless` now runs under Delo's guards, as the studio does. Web fetches of private, loopback and link-local addresses are refused, and a write to a skill, a preset or an `AGENTS.md` is refused, because nothing in a one-shot run can answer the approval it needs.
- Full access in a headless task, by `--permission-mode danger-full-access` or `DSH_PERMISSION_MODE=danger-full-access`, is refused before anything starts unless you granted full access for that folder in the studio. The message names the folder and how to grant it.
- DeepSeek's session-log upload is off by default in a headless task, as in the studio, and the feedback telemetry exporter is off.
- The task starts only after Delo has checked that these protections are active. If the headless setup lost them, `delorun headless` stops and says how to restore them: remove `profiles/headless/delo-migrations.json` or the `profiles/headless` folder in your Delo home.
