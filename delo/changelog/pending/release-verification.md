---
area: Install and update
section: Added
waits: a command or a startup step that calls the release verifier; nothing calls it today, so a person cannot run it
---

- A downloaded release can be verified against the public transparency log. The check reads the manifest's signature and the signing key's identity, finds the release's entry in the log, and confirms the entry sits in a tree that the log and a witness both signed off on, trusting only the keys Delo itself was installed with. When the log cannot be reached it records that the check is deferred and runs again at the next connection instead of blocking, and anything that does not add up is reported as a plain, typed reason rather than a generic error.
