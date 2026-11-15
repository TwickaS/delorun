---
area: Commands
section: Added
---

- A chat turn that starts before Delorun's start check has finished waits at most 60 seconds, then ends and says that the start check did not finish, that the message was not sent, and to start Delorun with `delorun start` and send it again; `delorun status` and `delorun logs` show what the start is doing. This only happens when Delorun was booted without `delorun`'s own start, or when the start's check never completes.
