---
description: "Types and fixed values of Delorun's update report contract (C3) for the pre-update report, the studio's update screens and the desktop updater: report items and reasons, update states of both installations, health-check criteria and rollback triggers."
kind: "package-library"
---

# @delorun/contract-update-report

English | [中文](README.zh.md)

## Summary

`@delorun/contract-update-report` defines the update report built before an update applies: its items with their kind, subject, reason, effect and verification, including the `harness` items for the files of the harness a person changed, how each merges (`HarnessMerge`), what the target runs of a carried file (`HarnessResult`) and a merged file's bounded diff (`HarnessDiff`), the `data-formats.json` record a release carries and the size of a session-data copy, the update states of the CLI home and the desktop Host, the health-check criteria and rollback triggers, and what an undo or restore approval prompt lists. The package holds exported types and readonly constants only, with no runtime code, so it never changes what a process does; the contract page [C3 Update report](../../docs/contracts/c03-update-report.md) is the authority, and this package follows it. Its entry is `src/index.ts`, exported as `.`.

## Contents

- [Use this package](#use-this-package)
- [Known limitations](#known-limitations)

## Use this package

The pre-update report in `delorun/packages/update/`, the studio's update screens, `delorun/packages/profile-safety/` and the desktop updater consume it. Import the types with `import type` and the constants with a value import from `@delorun/contract-update-report`; a package that reads or writes the files this contract defines still validates them at its parser, because these types describe valid files and do not check them.

## Known limitations

- The report's reason list is closed for report format 3 (`delorun.update-report/3`); a new reason needs a new format version, as the contract page states. Formats 1 and 2 are retired: no release shipped either.
- `UncheckedSource` has one value, `revocations`: no release publishes a revocation list, so a report names it in `notChecked`. The bundles' own layers and the bundles a target would skip are read, and are items rather than unchecked sources.
