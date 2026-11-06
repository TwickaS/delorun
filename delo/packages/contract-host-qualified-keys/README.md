---
description: "Types-only package holding the studio's host id type, host-qualified key forms and the inventory of persisted browser keys, as specified by contract C10."
---

# @delo/contract-host-qualified-keys

English | [中文](README.zh.md)

## Summary

This types-only package exports the host id type, the forms of a host-qualified key and the inventory of persisted browser keys that the studio writes. The studio's connection state, its stores, the trash screen and the enumeration spec import these definitions, so each persisted name and its scope have one definition. The specification is [contract C10](../../docs/contracts/c10-host-qualified-keys.md).

## Exports

- `HostId` and `HostQualifiedScope`: the branded host id and the scope of a host-qualified key.
- `HOST_ID_LENGTH` and `HOST_KEY_SEPARATOR`: the host id length and the separator between a host id and an upstream id.
- `PERSISTED_KEYS`: the fixed persisted browser entries, with the owner and the scope of each.
- `PERSISTED_SCOPE_KINDS`, `PersistedKeyEntry` and `PersistedKeyName`: the scope kinds, the entry type and the name union.
- `PERSISTED_DYNAMIC_KEYS`: the owner-named entries that the inventory lists by kind.
- `ORIGIN_SCOPED_COOKIE_PREFIX`: the prefix of the cookies that are outside the inventory.

## Limits

The package has no runtime code. It depends only on the workspace brand package, for the branded host id type. A change to an inventory entry follows the compatibility section of the contract.
