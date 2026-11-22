---
description: "The @delorun/setup-apply library: the writes that apply a setup answer to a profile, shared by the delorun command and the studio's How Delorun runs controls."
---

# @delorun/setup-apply

English | [中文](README.zh.md)

## Summary

This package holds the writes that turn a setup answer into the files a profile runs from, so `delorun setup` and the studio's How Delorun runs controls write them through one definition. It reads and merges rows into a profile's `cordis.patch.yml`, builds the patch rows of the prompts answer, the studio port and the Tailscale private reach option, reads and writes the `pairing` choice of the home-auth row, and rewrites a profile's `setup-answers.json`. It checks nothing about who may ask: the command checks the person at a terminal, and the studio's routes check the caller before they call it.

## Exports

- `setPatchRow`, `readPatchRow`, `updateRowConfig` and `setRowFields`: merge a row into a profile's patch list, read one row's config, and save a bundle row in the settings service's form. A patch row replaces the bundle row's whole `config`. Comments in the file do not survive a rewrite.
- `promptRows`, `writePromptRows` and `readPromptsRows`: the patch rows of the prompts answer (`safer`, `stock` or `dangerous`), their write, and the answer a patch holds. `PROMPT_SWITCH_ROWS` names the row of each switch, and `FULL_ACCESS_EVERYWHERE_KEY` the key that dangerous mode sets. The plugin honours that key only while the dangerous-mode grant file is valid, and this package never writes the grant.
- `DANGEROUS_WARNING_LINES` and `runsAsRoot`: the warning a person reads before turning dangerous mode on, and whether this process runs as root, which refuses it.
- `STUDIO_ROW_ID` and `studioRow`: the web server row that holds the studio's port.
- `readReachRowAt`, `writeReachRowAt`, `reachRowsOf`, `listenerPortFor`, `signInAddress`, `REACH_OFF` and `REACH_ROW_ID`: the `delorun-reach` row's Tailscale private option and its serve listener port. `TRUST_STATEMENT` is what phone access lets a device do and what protects the home, as `delorun reach on` prints it.
- `readPairingAt`, `writeMayAskAt` and `HOME_AUTH_ROW_ID`: the `pairing` choices of the `delorun-home-auth` row.
- `readAnswersRecord`, `promptsOf`, `backgroundOf`, `updateAnswersRecord` and `ANSWERS_FILENAME`: read `setup-answers.json`, the prompts and background answers it holds (setup's defaults for a missing or unreadable record), and rewrite it atomically at mode 0600. A profile with no record is refused a rewrite, because it never ran setup.
- `SetupApplyError`: the refusal of a file this package cannot use. Its message is a complete sentence.

Two leaf modules are also exported on their own, so a browser spec can read them without the Node-only rest: `@delorun/setup-apply/warning` (the dangerous-mode warning) and `@delorun/setup-apply/trust`.

## Limits

No function here takes a lock. The caller holds the home's write lock (`apps/cli/src/home-exclusion.ts`) across a read and the write that follows.

## Development

Tests are in `tests/`; they write only to temporary directories.
