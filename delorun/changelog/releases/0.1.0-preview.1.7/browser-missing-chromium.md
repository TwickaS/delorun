---
area: Plugins
section: Fixed
---

- Browser now says "Needs setup · Chromium download" in Plugins when the Chromium build its Playwright expects is missing, with the command that downloads that exact build. Before, it said Browser was ready whenever Chrome was installed. A browser step that still finds the build missing fails with one short message telling the agent to stop and ask you to finish Browser setup in Plugins.
