---
description: "Types and fixed values of Delorun's plugin version contract (C17) for the app-boot compatibility check, the CLI's version output, the update report and the catalogue corpus: the two version axes, their results and exemption files."
kind: "package-library"
---

# @delorun/contract-plugin-versions

English | [中文](README.zh.md)

## Summary

`@delorun/contract-plugin-versions` defines the two version axes a plugin is checked on, upstream's `engines.dsh` and Delorun's `engines.delorun`, the per-axis result of one evaluation, the exemption files and options of each axis, and the output of `delorun --version`. It also types `plugin-interface.json`, the inventory of the context services and manifest fields Delorun offers plugins (`covered`) and of the services and events Delorun's own packages and apps use (`internal`), which the release tool's patch rule keeps unchanged within a minor. The package holds exported types and readonly constants only, with no runtime code, so it never changes what a process does; the contract page [C17 Plugin version requirements](../../docs/contracts/c17-plugin-versions.md) is the authority, and this package follows it. Its entry is `src/index.ts`, exported as `.`, and the inventory is exported as `./plugin-interface.json`.

## Contents

- [Use this package](#use-this-package)
- [Known limitations](#known-limitations)

## Use this package

Upstream's app-boot compatibility hunk, `delorun/apps/cli/src/version.ts`, the pre-update report and the catalogue corpus consume it. Import the types with `import type` and the constants with a value import from `@delorun/contract-plugin-versions`; a package that reads or writes the files this contract defines still validates them at its parser, because these types describe valid files and do not check them.

## Known limitations

- Range matching itself is upstream's `evaluatePluginCompatibility` with `semver`; the package types its results for both axes and does not evaluate ranges. Which declaration decides is C17's rule: on Delorun a plugin that declares `engines.delorun` is checked on that range alone, and its upstream axis has the status `not-checked`.
