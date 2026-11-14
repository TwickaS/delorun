---
description: "Types and constants of Delorun's operational logs contract (C20), for the logger, every surface that writes a log, delorun logs and purge."
---

# @delorun/contract-operational-logs

English | [中文](README.zh.md)

## Summary

This package gives the code that implements contract C20 one source for the surfaces and their files, the log record, rotation and retention, the redactor's key names and limits, and the options of `delorun logs`. It holds types and readonly constants only, with no runtime behaviour. The [contract page](../../docs/contracts/c20-operational-logs.md) is the authority, and this package changes in the same pull request as the page.

## Contents

- [Use this package](#use-this-package)
- [Exports](#exports)

## Use this package

Import the record type and the limits instead of restating them:

```text
import { ROTATE_BYTES, type LogRecord } from '@delorun/contract-operational-logs'
```

The package is a dependency of `delorun/packages/logs`, `delorun/apps/cli` and every surface that writes through the logger.

## Exports

- **Surfaces:** `SURFACE_FILES`, `UPSTREAM_STARTUP_REPORTS` and `CLI_SURFACES`, with the `SurfaceKind` and `SurfaceName` types.
- **Records:** the `LogRecord`, `LogLevel`, `SessionId` and `WorkspaceId` types, `RECORD_MAX_BYTES` and `CAPTURED_LINE_MAX_BYTES`.
- **Rotation and retention:** `ROTATE_BYTES`, `KEPT_FILES`, `RETENTION_MS`, `AGE_CHECK_INTERVAL_MS`, `LOG_DIR_MODE` and `LOG_FILE_MODE`.
- **Redaction:** `MIN_REGISTERED_SECRET_LENGTH`, `REDACTED_KEY_PARTS` and `REDACTION_EXEMPT_FIELDS`, with the `SecretKind` type.
- **`delorun logs`:** `DEFAULT_TAIL_RECORDS` and `MAX_TAIL_RECORDS`.
