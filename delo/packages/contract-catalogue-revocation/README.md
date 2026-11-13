---
description: "Types and fixed values of Delo's catalogue contract (C13) for the catalogue repository, the revocation check and Discover: index entries, badge records, listed findings, the signed revocation list, its states and limits."
kind: "package-library"
---

# @delo/contract-catalogue-revocation

English | [中文](README.zh.md)

## Summary

`@delo/contract-catalogue-revocation` defines the catalogue index with its entries, badge records and listed findings, the signed revocation list, the revocation list's client states and the acceptance-ledger record of a finding, with the cache age, lifetimes, retry interval and text limits as constants. The package holds exported types and readonly constants only, with no runtime code, so it never changes what a process does; the contract page [C13 Catalogue index and revocation list](../../docs/contracts/c13-catalogue-revocation.md) is the authority, and this package follows it. Its entry is `src/index.ts`, exported as `.`.

## Contents

- [Use this package](#use-this-package)
- [Known limitations](#known-limitations)

## Use this package

No package in this repository consumes it: the catalogue client, the load-time revocation check and the Discover integration that C13 names are not built. Import the types with `import type` and the constants with a value import from `@delo/contract-catalogue-revocation`; a package that reads or writes the files this contract defines still validates them at its parser, because these types describe valid files and do not check them.

## Known limitations

- The display wording rules for badges and findings are stated on the contract page; the package carries only the list of wording no screen may use about a plugin.
