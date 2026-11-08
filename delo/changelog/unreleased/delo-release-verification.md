---
section: Added
---

- Delo now proves a downloaded release is the one its makers published before it runs. It checks the manifest's signature and the signing key's identity, finds the release's entry in the public transparency log, and confirms the entry sits in a tree that the log and a witness both signed off on — trusting only the keys Delo itself was installed with. A start without a network says so and checks again at the next connection instead of blocking, and anything that does not add up stops the start with a plain reason rather than a generic error.
