---
section: Added
---

- Delo's own processes keep operational logs at fixed locations under your Delo home. Every record is redacted before it is written, so keys, tokens, owner codes and cookie values Delo loads never reach a log; logs rotate at 10 MiB, keep 5 files, and are deleted 14 days after they were written while Delo runs. Your chats' session logs are not touched.
- `delorun logs` lists every log's location and shows a log's recent records, filtered by chat, turn or age, follows new records, prints the stored JSON, and clears or prunes logs on request.
