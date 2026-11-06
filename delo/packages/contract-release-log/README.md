---
description: "Types and fixed values of Delo's release log contract (C18) for release publishing, installers, the launcher's start check and the desktop updater: the Rekor release-log bundle, witness threshold, check states and retry interval."
kind: "package-library"
---

# @delo/contract-release-log

English | [中文](README.zh.md)

## Summary

`@delo/contract-release-log` defines the release-log bundle that carries a release manifest's Rekor entry, its inclusion proof and a witnessed checkpoint, the check states a client records per installed release, and the witness threshold, checkpoint age, retry interval and size limits as constants. The package holds exported types and readonly constants only, with no runtime code, so it never changes what a process does; the contract page [C18 Release log and witness](../../docs/contracts/c18-release-log.md) is the authority, and this package follows it. Its entry is `src/index.ts`, exported as `.`.

## Contents

- [Use this package](#use-this-package)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

The release workflow writes bundles; the install script, the npm launcher, the CLI launcher and home process, `delorun verify` and the desktop updater read them and record the check state. Import the types with `import type` and the constants with a value import from `@delo/contract-release-log`; a package that reads or writes the files this contract defines still validates them at its parser, because these types describe valid files and do not check them.

## Known Limitations and Deferred Work

- Checkpoint, cosignature and proof formats are the C2SP and RFC 6962 formats the page names; the package types them as strings and hex lists and does not parse them.
