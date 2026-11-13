---
description: "Types and fixed values of Delo's release manifest contract (C2) for the release build, installers, the runtime store and the desktop updater: signature envelope, root, timestamp and manifest files, runtime file lists, rebuild records and advisory acceptances."
kind: "package-library"
---

# @delo/contract-release-manifest

English | [中文](README.zh.md)

## Summary

`@delo/contract-release-manifest` defines the files of a Delo release: the Ed25519 signature envelope, the root and timestamp metadata with their key roles, the release manifest, the runtime file list, the rebuild record and the advisory acceptances, with the lifetimes and size limits as constants. The package holds exported types, readonly constants and one pure function, `isValidSummary`, which states the release summary's rule, so it never changes what a process does; the contract page [C2 Release manifest and signature](../../docs/contracts/c02-release-manifest.md) is the authority, and this package follows it. Its entry is `src/index.ts`, exported as `.`.

## Contents

- [Use this package](#use-this-package)
- [Known limitations](#known-limitations)

## Use this package

The release build in `delo/apps/release/`, the install script and npm launcher, the runtime store's start check and the desktop updater consume it, and the other release and catalogue contract packages import its digest, version and envelope types. Import the types with `import type` and the constants with a value import from `@delo/contract-release-manifest`; a package that reads or writes the files this contract defines still validates them at its parser, because these types describe valid files and do not check them.

## Known limitations

- Canonical JSON serialisation and Ed25519 verification are left to each consumer's chosen library; the package names the algorithms and does not implement them.
