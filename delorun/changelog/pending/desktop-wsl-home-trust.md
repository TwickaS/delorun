---
area: Safety and privacy
section: Security
waits: the Windows desktop app is published; it is not shipped yet
---

- The Windows desktop app opens a home in WSL2 as the person at the computer: it keeps the sign-in cookie and the one-time sign-in link inside the app's main process, never in a page, a log or a command line, and it forwards only its own page's requests to the home.
- On a home in WSL2 the app lets its own page act as a browser on the same PC would, so device approval and PIN changes work from the app; a request that names any other origin is refused, and a home on another machine never gets this. Script running in the app's page acts as the person at the computer, as in a browser, and the app does not stop another program of the same Windows user.
