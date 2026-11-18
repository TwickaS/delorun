---
area: Studio
section: Fixed
---

- A busy computer no longer makes Delorun think it has no sandbox. When the sandbox's start-up check fails or times out, Delorun checks again a few times, never remembers a failure beyond the command that met it, and says plainly that the fault is temporary: retry, or use a tool that needs no shell, such as web search. If the agent then asks to run without the sandbox, the approval card begins with "Delorun's sandbox had a problem; this asks to run without it", and declining tells the agent to retry inside the sandbox. A command is still never run unconfined because of a failed check.
- Commands run inside a chat's sandbox no longer refuse Delorun's home as "mode 0755" when the real folder is private; the sandbox's own view of folder modes is not trusted, and a truly open home is still refused everywhere else.
