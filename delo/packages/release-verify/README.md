---
description: "Client-side release-log verification of contract C18: the offline check of an installed release's bundle against the trusted root, the online consistency check, the stored checkpoint and the check state."
---

# @delo/release-verify

English | [中文](README.zh.md)

## Summary

An installed release ships a release-log bundle beside its manifest: the Rekor v2 `hashedrekord` entry of the manifest file, the entry's inclusion proof, and a checkpoint the log signed and a witness cosigned. This package verifies that bundle offline against the keys of the client's own trusted root, proves consistency with the log's latest checkpoint online, keeps the verified checkpoint and the check state of each installed release, and answers what a start does: go on, go on with a warning naming the unchecked release, or stop. The specification is [contract C18](../../docs/contracts/c18-release-log.md).

## Modules

- `bundle`, `entry`, `json` and `merkle`: the five offline steps, the Rekor v2 body, the strict reader, and RFC 6962 hashing.
- `note`, `checkpoint` and `online`: signed notes, the stored checkpoint that never moves backwards, and the consistency check.
- `state`, `start`, `service` and `paths`: the recorded check state, what a start does, the check service, and the two files' paths.

## Limits

The package holds no network code: the online check takes a transport, so the specs answer from fixtures and the launcher passes the gated one. It never signs either — nothing here can mint a checkpoint or an entry — and it trusts no key a bundle carries.
