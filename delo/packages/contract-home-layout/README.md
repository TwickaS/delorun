---
description: "Types and constants of Delo's home layout and runtime store contract (C1), for the CLI, the runtime store, the home process, the supervisor and the verification checks."
---

# @delo/contract-home-layout

English | [中文](README.zh.md)

## Summary

This package gives the code that implements contract C1 one source for its names, modes, limits and error codes: the `~/.delo` entries, the start token's size, the runtime store's pointer files, the launcher's download limits and the confinement rules that `delorun verify` reports. It holds types and readonly constants, and one pure function, the profile-name check `profileNameProblem`. The [contract page](../../docs/contracts/c01-home-layout.md) is the authority, and this package changes in the same pull request as the page.

## Contents

- [Use this package](#use-this-package)
- [Home entries](#home-entries)
- [Exports](#exports)

## Use this package

Import the names and limits instead of restating them:

```text
import { PRIVATE_DIR_MODE, RUN_ENTRIES, type ConfinementReport } from '@delo/contract-home-layout'
```

The package is a dependency of `delo/apps/cli`, `delo/packages/home`, `delo/packages/runtime-store`, `delo/packages/home-process`, `delo/packages/supervisor` and the other Delo packages that read or write the home, and of the other contract packages that share its token and version types.

## Home entries

`DELO_HOME_ENTRIES` names every top-level directory Delo adds to the home, and `ensureHomeTree` in `delo/packages/home` creates each at mode 0700:

- `runtimes/` and `staging/`: the runtime store and its installs in progress, written by `delo/packages/runtime-store`.
- `trust/`: the verified root, timestamp, log checkpoint and release-log check state, written by `delo/apps/install` and `delo/packages/release-verify`.
- `status/`: each installation's update status record, written by the CLI home and the desktop app.
- `catalogue/`: the verified catalogue index and revocation list.
- `secrets/`: one directory of secret files per owning package, such as `home-auth/`.
- `run/`: one run directory per CLI profile, and `run/data-users/`, written by `delo/packages/home`, the home process and `delorun`.
- `supervisor/`: the Docker supervisor's roots file, written by `delo/packages/supervisor`.
- `bin/`: the launcher copy the install script and login items use.
- `alerts/`: signed certificate-alert files.
- `data-copies/`: the session-data copy an update took and a restore's journal, written by `delo/packages/update`.
- `data-set-aside/`: the chat data a rollback replaced, written by `delo/packages/update`'s rollback.
- `trash/`: trashed chats and workspaces until retention ends or a restore, written by `delo/packages/trash` through the studio's trash plugin and `delorun trash`.
- `archive/`: workspace archive imports, staged and then published, written by `delorun import`.

The spec `tests/home-entries.spec.ts` scans the source of every Delo app and package for path joins under the home and fails on a top-level entry that neither this list nor upstream's entries name; its header states the patterns it reads and what it cannot see.

## Exports

- **Home:** `DELO_HOME_DIR_NAME`, `DELO_HOME_ENV`, `DELO_PROFILE_ENV`, `DSH_HOME_ENV`, `UPSTREAM_HOME_DIR_NAME`, `CLI_PROFILE`, `DESKTOP_PROFILE`, `HEADLESS_PROFILE`, `DATA_USERS_DIRECTORY`, `DELO_HOME_ENTRIES`, `READ_EXEMPTIONS`, `RUN_ENTRIES`, `SUPERVISOR_ROOTS_FILE`, `TRUST_FILES`, `STATUS_FILES` and `CATALOGUE_FILES`.
- **Profile names:** `RESERVED_PROFILE_NAMES`, each reserved name with why, `PROFILE_NAME_PATTERN` and `profileNameProblem`, the check the launcher and `delorun` apply to every profile name.
- **Modes:** `PRIVATE_DIR_MODE`, `PROTECTED_FILE_MODE` and `FORBIDDEN_MODE_BITS`, with the `ModeFinding` type.
- **Channels and the token:** `SOCKET_PATH_MAX_BYTES`, `WINDOWS_PIPE_PREFIX`, `HOME_ID_HEX_DIGITS`, `START_TOKEN_BYTES`, `START_TOKEN_LENGTH`, `HOME_STATUS_TIMEOUT_MS`, and the `StartToken`, `StartId` and `HomeLockRecord` types.
- **Runtime store:** `STORE_ENTRIES`, `STAGING_NAME_HEX_DIGITS`, `STORE_LAYOUT`, `LAUNCH_PROTOCOL`, `RUNTIME_VERSION_PATTERN`, `RUNTIME_VERSION_MAX_LENGTH`, `POINTER_FILE_MAX_BYTES`, `RETAINED_RUNTIME_VERSIONS`, `STORE_LOCK_WAIT_MS`, `POINTER_RENAME_RETRY_MS`, and the `RuntimeVersion` and `StoreLayoutRecord` types.
- **Launcher downloads:** `ARCHIVE_MAX_BYTES`, `MANIFEST_MAX_BYTES`, `DOWNLOAD_CONNECT_TIMEOUT_MS`, `DOWNLOAD_STALL_TIMEOUT_MS` and `RELEASE_DOWNLOAD_HOSTS`.
- **Confinement:** `CONFINEMENT_RULES` and the `ConfinementRule`, `SandboxDialect`, `RuleStatus`, `RuleReason`, `RuleFinding`, `DockerEndpoint` and `ConfinementReport` types.
- **Errors:** the `HomeLayoutErrorCode` type.
