---
description: "Types and fixed values of Delorun's release log contract (C18) for release publishing, installers, the launcher's start check and the desktop updater: the Rekor release-log bundle, witness threshold, check states and retry interval."
kind: "package-library"
---

# @delorun/contract-release-log

English | [中文](README.zh.md)

## Summary

`@delorun/contract-release-log` defines the Rekor v2 `hashedrekord` request and entry body of a release manifest with the entry key types a root may list (`LOG_ENTRY_KEY_TYPES`: `PKIX_ED25519_PH` with `SHA2_512`, `PKIX_ECDSA_P256_SHA_256` with `SHA2_256`), the release-log bundle that carries the entry, its inclusion proof and a witnessed checkpoint, the check states a client records per installed release, and the witness threshold, checkpoint age, retry interval and size limits as constants. The package holds exported types and readonly constants only, with no runtime code, so it never changes what a process does; the contract page [C18 Release log and witness](../../docs/contracts/c18-release-log.md) is the authority, and this package follows it. Its entry is `src/index.ts`, exported as `.`.

## Contents

- [Use this package](#use-this-package)
- [Known limitations](#known-limitations)

## Use this package

The release workflow writes bundles; the install script, the npm launcher, the CLI launcher and home process, `delorun verify` and the desktop updater read them and record the check state. Import the types with `import type` and the constants with a value import from `@delorun/contract-release-log`; a package that reads or writes the files this contract defines still validates them at its parser, because these types describe valid files and do not check them.

## Known limitations

- Checkpoint, cosignature and proof formats are the C2SP and RFC 6962 formats the page names; the package types them as strings and hex lists and does not parse them.
