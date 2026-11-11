---
kind: upgrade-guide
description: "delorun update and the update channel refuse a target lower than the running Delo release."
---

# `delorun update` refuses a lower release

English | [中文](guide.zh.md)

## Change

`delorun update` used to apply whatever release the channel named whenever it differed from the running one, lower or higher, and the home process's `update.prepare` request accepted any installed version as its `target`. An update now never goes to a lower version. The runtime store refuses a channel release or a `target` lower than the version `current` names with `TARGET_LOWER`, before anything is downloaded or installed, and the home process answers `update.prepare` with `VERIFY_FAILED` naming it. `delorun update` also refuses, with exit status 1, a report whose target is lower than the running release, `--yes` included.

This affects anyone who moved back to an earlier release with `delorun update`, for example after switching to a channel whose current release is lower, and scripts that send `update.prepare` with a lower `target`.

## Migration

1. To go back to the release before the last update, run `delorun recover rollback`; add `--profile-only` to restore only the profile. It reaches only the version the runtime store's `previous` pointer names.
2. To run an older release that is not `previous`, install it into an empty home with the launcher of that release, `npx delorun@<version> --release <version>`.
3. Remove any `target` lower than the running version from scripts that send `update.prepare`.
4. Confirm with `delorun status`, which names the version that runs.
