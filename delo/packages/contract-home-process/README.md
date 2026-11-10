---
description: "Types and constants of Delo's home process and update handshake contract (C19), for the home process, the delorun command and the studio's update plugin."
---

# @delo/contract-home-process

English | [中文](README.zh.md)

## Summary

This package gives the code that implements contract C19 one source for the update channel's requests and responses, the home process's states, the handshake's phases and outcomes, the update journal and every limit. It holds types and readonly constants only, with no runtime behaviour. The [contract page](../../docs/contracts/c19-home-process.md) is the authority, and this package changes in the same pull request as the page.

## Contents

- [Use this package](#use-this-package)
- [Exports](#exports)

## Use this package

Import the protocol's types and limits instead of restating them:

```text
import { REQUEST_MAX_BYTES, type UpdateChannelRequest } from '@delo/contract-home-process'
```

The package is a dependency of `delo/packages/home-process`, `delo/apps/cli` and the Host's update plugin in `@delo/bundle-local`. It uses the token, start id and version types of [`@delo/contract-home-layout`](../contract-home-layout/README.md).

## Exports

- **Protocol:** `UPDATE_PROTOCOL_VERSION`, the request types `StatusRequest`, `UpdatePrepareRequest`, `UpdateApplyRequest`, `UpdateCancelRequest`, `RollbackRequest`, `StopRequest`, `StudioOpenTokenRequest` and their union `UpdateChannelRequest`, with `DrainArgs`, `UpdateChannelResponse`, `HomeStatus` and `StudioLink`, the answer to `studio.open-token`.
- **States and phases:** the `HomeProcessState`, `UpdatePhase`, `UpdateOutcome`, `DrainPolicy` and `StopMode` types.
- **Records:** the `UpdateJournal` type of the update record `run/<profile>/update.json`, the `HandoverMessage` type, and `HANDOVER_FD`.
- **Limits:** `HOME_PROCESSES_PER_PROFILE`, `START_WAIT_MS`, `STOP_NOW_ANSWER_MS`, `STOP_TERM_GRACE_MS`, `STOP_KILL_WAIT_MS`, `REQUEST_MAX_BYTES`, `REQUEST_DEADLINE_MS`, `MAX_CONNECTIONS`, `AUTH_FAILURE_LOG_LINES_PER_SECOND`, `REPORT_LIFETIME_MS`, `DRAIN_TIMEOUT_MIN_S`, `DRAIN_TIMEOUT_MAX_S`, `DRAIN_TIMEOUT_DEFAULT_S`, `HEALTH_CHECK_TIMEOUT_MS`, `LOGIN_RESTART_LIMIT`, `LOGIN_RESTART_WINDOW_MS` and `STATUS_EXIT_NOT_RUNNING`.
- **Errors:** the `HomeProcessErrorCode` type.
