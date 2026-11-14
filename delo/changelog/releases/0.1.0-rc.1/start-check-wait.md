---
area: Commands
section: Changed
---

- A chat turn that starts before Delo's start check has finished no longer waits without a message: after 60 seconds the turn ends and says that the start check did not finish, that the message was not sent, and to start Delo with `delorun start` and send it again; `delorun status` and `delorun logs` show what the start is doing. This only happens when Delo was booted without `delorun`'s own start, or when the start's check never completes.
