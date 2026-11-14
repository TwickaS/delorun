---
area: Install and update
section: Security
---

- A Delo release and its freshness timestamps are signed only with keys the public repository records as Delo's production keys, so nothing is signed until those keys are recorded. A release is signed only when its version tag carries the signature of a release signer that the release branch of the public repository lists, not a local copy of that list, and the tagged code is on the release branch, and only when the `delorun` npm package it records, by name, version and checksum, is the package the release built. Until install scripts are rebuilt and compared like the rest of a release, no release lists one.
- A test release built on someone's own computer can never be signed with Delo's real release keys, so a launcher that trusts Delo's releases never accepts one.
