---
description: "Types-only package holding the answer types, defaults and upstream profile row names of delorun setup, as specified by contract C11."
---

# @delo/contract-setup-answers

English | [中文](README.zh.md)

## Summary

This types-only package exports the answers document of `delorun setup`: its types, the model providers setup offers, its defaults, the keys earlier documents carried and setup no longer asks, the upstream profile rows that the Privacy section's two opt-ins write, and the row the release-check answer writes. The interactive setup, the `--yes` and `--config` forms and the studio's consent screen import these definitions, so each default has one source. The specification is [contract C11](../../docs/contracts/c11-setup-answers.md).

## Exports

- `SetupAnswers`, `ModelProviderAnswer`, `ReachAnswer`, `ProfileAnswer`, `SectionRecord` and `ModelCredential`: the answer types.
- `SETUP_PROVIDER_IDS` and `SetupProviderId`: the model providers setup offers, by the route id the profile selects each with; setup's provider table in `delo/apps/cli` holds each one's adapter, key variable and key check.
- `REACH_OPTIONS`, `IDENTITY_FACTORS`, `PROMPTS_OPTIONS` and `SECTION_STATUSES`, with the union types derived from each; `PROMPTS_OPTIONS` holds `safer`, `stock` and `dangerous`, and `DANGEROUS_PHRASE` is the text a person types to confirm `dangerous`.
- `REMOVED_ANSWER_KEYS`: the keys of earlier answers documents that `--config` refuses by name.
- `SETUP_DEFAULTS`: the default value of every answer.
- `SETUP_OPT_IN_ROWS`: the upstream row that each opt-in on the Privacy section writes. Setup no longer asks either. `SETUP_UPDATE_CHECK_ROW`: the `@delo/bundle-local` row that the `updateCheck` answer and the Privacy section's release-check switch write.
- `SETUP_ANSWERS_SCHEMA_VERSION`, `SETUP_ANSWERS_EARLIER_SCHEMA_VERSIONS`, `SETUP_DEFAULT_PROVIDER_ID`, `SETUP_DEFAULT_CREDENTIAL_VARIABLE` and `SETUP_DEFAULT_PORT`: the schema version setup writes, the earlier versions it still reads, the provider the interactive question starts on, DeepSeek's key variable and the studio's default port.

## Limits

The package has no runtime code and no dependencies. A change to an answer follows the compatibility section of the contract.
