---
area: Reach
section: Added
waits: the device sign-in library mounted in a shipped profile and delorun setup printing the owner code; nothing imports the library and setup prints no code today
---

- The first device to claim your Delorun home becomes its owner, using the one-time code that `delorun setup` prints: the code works once, expires ten minutes after it was printed, and a freshly printed code replaces it. A home nobody has claimed says so when you ask for its devices, instead of acting as if it had none.
- A home lists the devices you have trusted, with when each last signed in and where it is trusted. Removing one signs that device out of every open session before the removal finishes, so nothing keeps answering in its name, and it leaves your other devices signed in. The home does not yet renew the other devices' sessions when one is removed.
