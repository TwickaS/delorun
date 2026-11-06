---
description: "Types-only package holding Delo's verification check registry, results, modes, stages and report types, as specified by contract C15."
---

# @delo/contract-verification-checks

English | [中文](README.zh.md)

## Summary

This types-only package exports the verification check registry of Delo, with the results, modes, stages and report types that the checks and the readers of their reports use. The integrity package, the `delorun` command and the studio's Verification panel import these definitions, so each check identifier and its effect in `enforce` mode have one definition. The specification is [contract C15](../../docs/contracts/c15-verification-checks.md).

## Exports

- `VERIFICATION_CHECKS` and `VERIFICATION_CHECK_IDS`: the registry and the check identifiers.
- `VERIFICATION_MODES`, `VERIFICATION_STAGES`, `VERIFICATION_RESULTS` and `VERIFICATION_BLOCKS`, with the union types derived from each.
- `VerificationReport`, `VerificationCheckResult` and `MachineVerificationReport`: the report types.
- `VERIFICATION_REPORT_SCHEMA_VERSION`, `VERIFICATION_NOTICE`, `VERIFICATION_DETAIL_MAX_LENGTH`, `VERIFICATION_MODE_SETTING` and `VERIFICATION_CHALLENGE_BYTES`: the schema version, the notice, the detail length limit, the setting key and the challenge length.

## Limits

The package has no runtime code and no dependencies. A change to a check follows the compatibility section of the contract.
