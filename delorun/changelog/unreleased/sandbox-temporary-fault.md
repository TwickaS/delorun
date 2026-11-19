---
area: Studio
section: Fixed
---

- A busy computer, or Docker Desktop starting and stopping containers under WSL, no longer makes Delorun think it has no sandbox. When the sandbox's start-up check times out or the computer is briefly out of memory or processes, Delorun checks again a few times without freezing, never remembers a failure beyond the command that met it, and says plainly that the fault is temporary: retry, or use a tool that needs no shell, such as web search. A sandbox that fails to start because a mount point vanished is repeated once with a fresh mount list, and Docker Desktop's changing mount folders are left out of the sandbox's view. A lasting cause, such as a blocked user namespace, still gets the install advice.
- If the agent then asks to run without the sandbox, the approval card shows "Delorun's sandbox had a problem; this asks to run without it" as its own line, offers no "allow for this chat" choice, and declining tells the agent to retry inside the sandbox. The note clears after the next sandboxed command runs. A command is still never run unconfined because of a failed check.
- Commands run inside a chat's sandbox no longer refuse Delorun's home as "mode 0755" when the real folder is private. Only Delorun's own sandbox launcher marks that view as untrustworthy; anywhere else a 0755 home is still refused.
- Delorun's own start, setup and update commands always check that its home is private, even from inside a chat's sandbox.
