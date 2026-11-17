---
area: Plugins
section: Changed
---

- Browser uses Google Chrome when you have it installed, so it needs no download and no setup. Chrome runs in a fresh profile of its own, never your Chrome profile. Without Chrome, Browser uses Playwright's Chromium as before, and Plugins shows "Needs setup · Chromium download" until that build is there. A Delorun update can need a new Chromium download only in that case. To always use one of the two, set `browser: chrome` or `browser: chromium` on the `browser-use-playwright-mcp` row. Restart Delorun after you install or remove Chrome.
