---
area: Studio
section: Added
---

- The studio's sidebar foot shows how much of this Delorun was checked: a small badge reads verified only when every runtime file was hashed by a full check and the release log, the plugins and your changes all check out, reads "Checked at start" after an ordinary start, which hashes only part of the runtime, turns red for a failed check and amber for an unknown release, an unchecked release log, a plugin changed after its install or a critical advisory, and shows your own changes, including those waiting for your review, as a plain count. It opens a panel with the four rows, their details, and Check now, which runs `delorun verify` through the launcher, so every runtime file is hashed before the check runs, and shows how long it has run. A phone or laptop you approved for remote access sees the panel read-only; Check now runs only on the computer Delorun runs on. The panel says that these checks run with your access, so a program running as you can change them.
