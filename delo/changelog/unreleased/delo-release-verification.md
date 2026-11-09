---
section: Added
---

- A downloaded release can now be verified against the public transparency log. The new `@delo/release-verify` library checks the manifest's signature and the signing key's identity, finds the release's entry in the log, and confirms the entry sits in a tree that the log and a witness both signed off on — trusting only the keys Delo itself was installed with. When the log cannot be reached it records that the check is deferred and runs again at the next connection instead of blocking, and anything that does not add up is reported as a plain, typed reason rather than a generic error.
