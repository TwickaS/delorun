---
description: "Types-only package holding the answer types, defaults and upstream profile row names of delorun setup, as specified by contract C11."
---

# @delo/contract-setup-answers

English | [中文](README.zh.md)

## Summary

This types-only package exports the answers document of `delorun setup`: its types, its defaults and the upstream profile rows that the two opt-in answers write. The interactive setup, the `--yes` and `--config` forms and the studio's consent screen import these definitions, so each default has one source. The specification is [contract C11](../../docs/contracts/c11-setup-answers.md).

## Exports

- `SetupAnswers`, `RuntimeAnswer`, `ReachAnswer` and `ModelCredential`: the answer types.
- `REACH_OPTIONS`, `IDENTITY_FACTORS`, `DOCKER_SHAPES` and `RESOURCE_PRESETS`, with the union types derived from each.
- `SETUP_DEFAULTS`: the default value of every answer.
- `SETUP_OPT_IN_ROWS`: the upstream row that each opt-in answer writes.
- `SETUP_ANSWERS_SCHEMA_VERSION`, `SETUP_DEFAULT_PROVIDER_ID` and `SETUP_DEFAULT_CREDENTIAL_VARIABLE`: the schema version, the default provider id and the default credential variable.

## Limits

The package has no runtime code and no dependencies. A change to an answer follows the compatibility section of the contract.
