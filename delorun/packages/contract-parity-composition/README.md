---
description: "Types-only package holding Delorun's parity-composition switch registry, its base tag and its overlay path, as specified by contract C16."
---

# @delorun/contract-parity-composition

English | [中文](README.zh.md)

## Summary

This types-only package exports the switch registry of Delorun's parity composition, the upstream base tag it replays and the path of its overlay. Each package that registers a model-visible switch and the replay tools import the registry from here, so every switch id and parity value has one definition. The specification is [contract C16](../../docs/contracts/c16-parity-composition.md).

## Exports

- `PARITY_SWITCHES`: the registry, with one entry per model-visible Delorun change and one for the doctor's feature switch. A built entry names its Config field and the source files whose model-visible contributions it turns off; a planned entry names the work package that builds it.
- `ParitySwitchEntry`, `BuiltParitySwitch`, `PlannedParitySwitch` and `ParitySwitchField`: the entry types and the field of a built switch, which is a boolean Config field (`ParityBooleanField`) or the presence of a key on the module's row (`ParityPresenceField`).
- `ParitySwitch` and `ParitySwitchId`: the declared entry type and the id union derived from the registry.
- `PARITY_REGISTRY_VERSION`, `PARITY_BASE_TAG`, `PARITY_OVERLAY_PATH` and `PARITY_OVERLAY_ENV`: the registry version, the upstream base tag, the overlay path and the variable that hands the overlay to the snapshot adapters.

The `parity-switches` check in `@delorun/tools` holds the registry against the switch fields in the tree; its rules are in the parity composition section of the [tools README](../../apps/tools/README.md).

## Limits

The package has no runtime code and no dependencies. A change to an entry follows the compatibility section of the contract.
