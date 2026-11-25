---
area: Compatibility
section: Fixed
---

- The compatibility bench closes the first-use dialogs topmost first, so a plugin that opens a dialog of its own before the studio's first-run guide appears is exercised instead of stuck: the guide painted above the plugin's dialog, the click aimed at the first dialog in the page was intercepted, and every stage that drives the browser failed on it.
- The bench asks the host for a sign-in link for up to fifteen seconds after a studio start, because the studio answers on its port before the home process reports a host and `delorun open --print` then answers that no host is running.
