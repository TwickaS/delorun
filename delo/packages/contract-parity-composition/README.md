---
description: "Types-only package holding Delo's parity-composition switch registry, its base tag and its overlay path, as specified by contract C16."
---

# @delo/contract-parity-composition

English | [中文](README.zh.md)

## Summary

This types-only package exports the switch registry of Delo's parity composition, the upstream base tag it replays and the path of its overlay. Each package that registers a model-visible switch and the replay tools import the registry from here, so every switch id and parity value has one definition. The specification is [contract C16](../../docs/contracts/c16-parity-composition.md).

## Exports

- `PARITY_SWITCHES`: the registry, with one entry per model-visible Delo change.
- `ParitySwitch` and `ParitySwitchId`: the entry type and the id union derived from the registry.
- `PARITY_REGISTRY_VERSION`, `PARITY_BASE_TAG` and `PARITY_OVERLAY_PATH`: the registry version, the upstream base tag and the overlay path.

## Limits

The package has no runtime code and no dependencies. A change to an entry follows the compatibility section of the contract.
