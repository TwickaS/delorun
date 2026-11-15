---
area: Safety and privacy
section: Security
---

- `delorun stop --now` ends a Delorun that does not answer or does not exit, with `SIGTERM` and then `SIGKILL`, but only after it confirms the process is the one holding the profile's lock; a process it cannot confirm is never signalled, and the command says which process to check. On Windows it never signals.
- A start that Delorun refuses after the studio has booted now stops that studio itself and always reports why with a non-zero exit, after the refusal and the recovery of an interrupted update have run.
- Refusals and unexpected failures are printed in the same what, why and what-you-can-do form with secrets such as API keys redacted, and an unexpected failure's full detail goes to the home process's log instead of a stack trace on the terminal.
- `delorun recover rollback` with no Delorun running now counts as the only user of your chats while it runs, so another profile's Delorun cannot start in the middle of it; `delorun plugin` counts as a user of your chats while it runs.
- The record of Delorun's one-time profile changes now lives with the profile, and an unreadable record makes Delorun skip the changes and say so, so a change you undid is not made again.
