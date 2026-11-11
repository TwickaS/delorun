---
area: Safety and privacy
section: Security
---

- A task run with `delorun headless` now runs under Delo's guards, as the studio does. Web fetches of private, loopback and link-local addresses are refused, and a write to a skill, a preset or an `AGENTS.md`, a new stdio MCP server and a scheduled follow-up are refused, because nothing in a one-shot run can answer the approval they need. The task's model cannot turn these guards off through plugin management.
- Full access in a headless task is refused unless you turned on full access for that folder, with `delorun workspace full-access <folder> on` or in the studio. A request for it with `--permission-mode` (`danger-full-access` or a preset of yours that selects it) or `DSH_PERMISSION_MODE=danger-full-access` is refused before anything starts, with a message that names the folder and the command that grants it; any other way of switching to full access during the task is refused by the same consent inside Delo.
- DeepSeek's session-log upload is off by default in a headless task, as in the studio, and the feedback telemetry exporter is off.
- The task starts only after Delo has checked that these protections are active. If the headless setup lost them, `delorun headless` stops and says how to restore them: remove `profiles/headless/delo-migrations.json` or the `profiles/headless` folder in your Delo home.
