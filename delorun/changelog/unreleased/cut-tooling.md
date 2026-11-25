---
area: Commands
section: Fixed
---

- A release cut after a signing-key rotation no longer stops part-way. The cut now accepts the whole chain of trust roots, oldest first, so it passes both the root a signer's state already trusts and the new one; only the newest is used to probe the release log.
- A publish no longer fails when the storage service drops a connection under load. Each store call is tried up to three times with a growing pause, and an answer the bucket actually gives is never retried.
