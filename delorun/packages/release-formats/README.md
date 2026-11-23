---
description: "The release file formats both Delorun's release tooling and its shipped verifiers read: signed metadata and its client verification (C2), the release-log entry, bundle, signed notes, Merkle proofs and tiles (C18), and the deterministic archive formats."
---

# @delorun/release-formats

English | [中文](README.zh.md)

## Summary

The formats of a Delorun release, in one place that both sides use: the release tooling in [`delorun/apps/release`](../../apps/release/README.md), which writes and signs releases, and the shipped code that installs and checks them (`@delorun/install`, the launcher, `@delorun/runtime-store`, `@delorun/release-verify`, `delorun verify` and the relay's token format). The package depends on the release contracts and on no CLI, developer tooling or runtime closure, so the runtime closure carries the verifier and none of the tooling, and no package that ships depends on the release app. The specifications are [contract C2](../../docs/contracts/c02-release-manifest.md) and [contract C18](../../docs/contracts/c18-release-log.md).

## Modules

- `sign/json`: RFC 8785 canonical JSON, which every signature covers, and the strict reader that refuses a duplicate key.
- `sign/envelope`: the signature envelope, key ids and signing, and `sign/schemas`, the readers of each signed file.
- `sign/verify`: C2's client verification of the root chain, the timestamp, the channel's manifest and each file reference.
- `log/entry`, `log/entry-keys`, `log/bundle`, `log/note`, `log/merkle` and `log/tiles`: the Rekor v2 entry signed with Ed25519ph or ECDSA P-256, the log-entry keys and logs a root allows (`listedEntryKey`, `entrySigners`, `trustedLogs`), shared with `@delorun/release-verify`, the offline bundle check in C18's five steps, C2SP signed notes and cosignatures, RFC 6962 proofs, and proofs computed from `tlog-tiles`.
- `archive/*`: the deterministic tar, gzip and ZIP writers and readers, the archive entry rules, the inspection of the deterministic form, and the PE normalisation the rebuild comparison uses (`archive/pe`).
- `brands`: the semantic-version and SHA-256 brands.
- `gate/home-paths`: the scan for the building user's home directory, user name as a folder and unique build root in a directory's files and archives, which the release build and the launcher build run over their output and refuse on.

The specs of `sign`, `log` and `archive` live beside the release tooling that writes these formats, under `delorun/apps/release/tests/{sign,log,archive}`; the specs of `gate/home-paths` live in this package's `tests/`.
