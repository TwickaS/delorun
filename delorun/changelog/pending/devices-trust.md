---
area: Reach
section: Security
waits: the device sign-in library mounted in a shipped profile; nothing imports it today
---

- Asking the home which devices you trust, or removing one, works only on the home's own computer. A page opened from another address can no longer read your device list or remove a device, even when its name happens to reach the home, and a removal has to come from the studio itself rather than from another site.
- Signing in needs a device the home actually trusts, on the address it was trusted on: a key from another home, a device that was removed and a device approved for a different address are refused, and a device stops answering the moment its record is gone.
- A home keeps at most 32 trusted devices and one device holds at most 16 open sessions; past either bound the home says so instead of growing without limit.
