---
description: "Types and constants of Delo's home layout and runtime store contract (C1), for the CLI, the runtime store, the home process, the supervisor and the verification checks."
---

# @delo/contract-home-layout

English | [中文](README.zh.md)

## Summary

This package gives the code that implements contract C1 one source for its names, modes, limits and error codes: the `~/.delo` entries, the start token's size, the runtime store's pointer files, the launcher's download limits and the confinement rules that `delorun verify` reports. It holds types and readonly constants only, with no runtime behaviour. The [contract page](../../docs/contracts/c01-home-layout.md) is the authority, and this package changes in the same pull request as the page.

## Contents

- [Use this package](#use-this-package)
- [Exports](#exports)

## Use this package

Import the names and limits instead of restating them:

```text
import { PRIVATE_DIR_MODE, RUN_ENTRIES, type ConfinementReport } from '@delo/contract-home-layout'
```

The package is a dependency of `delo/apps/cli`, `delo/packages/runtime-store`, `delo/packages/home-process`, `delo/packages/supervisor` and `delo/packages/integrity`, and of the other contract packages that share its token and version types.

## Exports

- **Home:** `DELO_HOME_DIR_NAME`, `DELO_HOME_ENV`, `DELO_PROFILE_ENV`, `DSH_HOME_ENV`, `UPSTREAM_HOME_DIR_NAME`, `CLI_PROFILE`, `DESKTOP_PROFILE`, `DELO_HOME_ENTRIES`, `READ_EXEMPTIONS`, `RUN_ENTRIES` and `SUPERVISOR_ROOTS_FILE`.
- **Modes:** `PRIVATE_DIR_MODE`, `PROTECTED_FILE_MODE` and `FORBIDDEN_MODE_BITS`, with the `ModeFinding` type.
- **Channels and the token:** `SOCKET_PATH_MAX_BYTES`, `WINDOWS_PIPE_PREFIX`, `HOME_ID_HEX_DIGITS`, `START_TOKEN_BYTES`, `START_TOKEN_LENGTH`, `HOME_STATUS_TIMEOUT_MS`, and the `StartToken`, `StartId` and `HomeLockRecord` types.
- **Runtime store:** `STORE_ENTRIES`, `STORE_LAYOUT`, `LAUNCH_PROTOCOL`, `RUNTIME_VERSION_PATTERN`, `RUNTIME_VERSION_MAX_LENGTH`, `POINTER_FILE_MAX_BYTES`, `RETAINED_RUNTIME_VERSIONS`, `STORE_LOCK_WAIT_MS`, `POINTER_RENAME_RETRY_MS`, and the `RuntimeVersion` and `StoreLayoutRecord` types.
- **Launcher downloads:** `ARCHIVE_MAX_BYTES`, `MANIFEST_MAX_BYTES`, `DOWNLOAD_CONNECT_TIMEOUT_MS`, `DOWNLOAD_STALL_TIMEOUT_MS` and `RELEASE_DOWNLOAD_HOSTS`.
- **Confinement:** `CONFINEMENT_RULES` and the `ConfinementRule`, `SandboxDialect`, `RuleStatus`, `RuleReason`, `RuleFinding`, `DockerEndpoint` and `ConfinementReport` types.
- **Errors:** the `HomeLayoutErrorCode` type.
