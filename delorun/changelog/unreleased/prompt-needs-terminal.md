---
area: Setup
section: Fixed
---

- Commands that ask a question, such as `delorun devices approve`, now stop with "this needs you at a terminal to answer; run it in one" when they run where nobody can answer (a script, or a tool's one-shot shell), instead of ending with a Node warning about an unsettled top-level await.
