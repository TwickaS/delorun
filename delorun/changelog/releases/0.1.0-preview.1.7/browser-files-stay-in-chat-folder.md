---
area: Safety and privacy
section: Security
---

- Browser refuses to save or upload a file whose path really lies outside the chat's folder. Playwright's own check compares paths as text, so a link inside a project could lead a screenshot, PDF or upload somewhere else on the computer. The agent is told to use a path inside the chat's folder. If a project's `.playwright-mcp` is itself a link to somewhere else, Browser's tools stop until you remove it, because downloads and default-named files would follow it.
- Browser no longer gives the agent Playwright's `browser_run_code_unsafe` tool. It ran code the agent wrote on your computer, outside the page and outside the sandbox.
- The folder in the Delorun home that Browser's server runs in is kept private to you, including when it already existed with wider access.
