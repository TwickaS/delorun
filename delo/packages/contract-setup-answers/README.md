---
description: "Types-only package holding the answer types, defaults and upstream profile row names of delorun setup, as specified by contract C11."
---

# @delo/contract-setup-answers

English | [中文](README.zh.md)

## Summary

This types-only package exports the answers document of `delorun setup`: its types, its defaults, the keys earlier documents carried and setup no longer asks, and the upstream profile rows that the Privacy section's two opt-ins write. The interactive setup, the `--yes` and `--config` forms and the studio's consent screen import these definitions, so each default has one source. The specification is [contract C11](../../docs/contracts/c11-setup-answers.md).

## Exports

- `SetupAnswers`, `ReachAnswer`, `ProfileAnswer`, `SectionRecord` and `ModelCredential`: the answer types.
- `REACH_OPTIONS`, `IDENTITY_FACTORS`, `PROMPTS_OPTIONS` and `SECTION_STATUSES`, with the union types derived from each.
- `REMOVED_ANSWER_KEYS`: the keys of earlier answers documents that `--config` refuses by name.
- `SETUP_DEFAULTS`: the default value of every answer.
- `SETUP_OPT_IN_ROWS`: the upstream row that each opt-in on the Privacy section writes. Setup no longer asks either.
- `SETUP_ANSWERS_SCHEMA_VERSION`, `SETUP_DEFAULT_PROVIDER_ID`, `SETUP_DEFAULT_CREDENTIAL_VARIABLE` and `SETUP_DEFAULT_PORT`: the schema version, the default provider id, the default credential variable and the studio's default port.

## Limits

The package has no runtime code and no dependencies. A change to an answer follows the compatibility section of the contract.
