---
area: Install and update
section: Security
---

- A Delo release is signed only when its version tag carries the signature of a release signer the public repository lists and the tagged code is on the release branch, and only when the `delorun` npm package it records, by name, version and checksum, is the package the release built. Until install scripts are rebuilt and compared like the rest of a release, no release lists one.
- A test release built on someone's own computer can never be signed with Delo's real release keys, so a launcher that trusts Delo's releases never accepts one.
