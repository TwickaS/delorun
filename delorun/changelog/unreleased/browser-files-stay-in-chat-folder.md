---
area: Safety and privacy
section: Security
---

- Browser refuses to save or upload a file whose path really lies outside the chat's folder. Playwright's own check compares paths as text, so a link inside a project could lead a screenshot, PDF or upload somewhere else on the computer. The agent is told to use a path inside the chat's folder.
- The folder in the Delorun home that Browser's server runs in is kept private to you, including when it already existed with wider access.
