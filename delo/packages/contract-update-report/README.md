---
description: "Types and fixed values of Delo's update report contract (C3) for the pre-update report, the studio's update screens and the desktop updater: report items and reasons, update states of both installations, health-check criteria and rollback triggers."
kind: "package-library"
---

# @delo/contract-update-report

English | [中文](README.zh.md)

## Summary

`@delo/contract-update-report` defines the update report built before an update applies: its items with their kind, subject, reason, effect and verification, the `data-formats.json` record a release carries and the size of a session-data copy, the update states of the CLI home and the desktop Host, the health-check criteria and rollback triggers, and what an undo or restore approval prompt lists. The package holds exported types and readonly constants only, with no runtime code, so it never changes what a process does; the contract page [C3 Update report](../../docs/contracts/c03-update-report.md) is the authority, and this package follows it. Its entry is `src/index.ts`, exported as `.`.

## Contents

- [Use this package](#use-this-package)
- [Known limitations](#known-limitations)

## Use this package

The pre-update report in `delo/packages/update/`, the studio's update screens, `delo/packages/profile-safety/` and the desktop updater consume it. Import the types with `import type` and the constants with a value import from `@delo/contract-update-report`; a package that reads or writes the files this contract defines still validates them at its parser, because these types describe valid files and do not check them.

## Known limitations

- The report's reason list is closed for report format 2 (`delo.update-report/2`); a new reason needs a new format version, as the contract page states. Format 1 is retired: no release shipped it.
- `UncheckedSource` has one value, `revocations`: no release publishes a revocation list, so a report names it in `notChecked`. The bundles' own layers and the bundles a target would skip are read, and are items rather than unchecked sources.
