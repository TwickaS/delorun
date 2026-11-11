---
area: Safety and privacy
section: Security
---

- In a task run with `delorun headless`, an agent's request to install, update or remove a plugin no longer runs: it waits in `delorun changes` for you to apply or discard it at your computer, as in the studio. The agent's first write to the folder of a plugin you approved asks for your approval, which nothing in a one-shot run can give, so the write is refused.
