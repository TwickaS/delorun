---
section: Added
---

- A composition can now forbid embedded code in its own patch files: with `refuseCode` on, loading refuses `!!js` expressions and patch `insert` rows and fails with an error naming the file and where the code sits. The switch is off, which changes nothing.
