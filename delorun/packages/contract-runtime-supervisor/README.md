---
description: "Types and constants of Delorun's runtime and supervisor contract (C9), for the runtime provider, the Docker supervisor, the Docker shapes and the studio's workspace plugin."
---

# @delorun/contract-runtime-supervisor

English | [中文](README.zh.md)

## Summary

This package gives the code that implements contract C9 one source for the runtime provider's operations, the capability report, the supervisor's closed request schema, the resource presets, the egress defaults, credential forwarding, the S2 helper channel, the images and the container denial marker. It holds types and readonly constants only, with no runtime behaviour. The [contract page](../../docs/contracts/c09-runtime-supervisor.md) is the authority, and this package changes in the same pull request as the page.

## Contents

- [Use this package](#use-this-package)
- [Exports](#exports)

## Use this package

Import the schemas, presets and limits instead of restating them:

```text
import { PRESETS, type SupervisorRequest } from '@delorun/contract-runtime-supervisor'
```

The package is a dependency of `delorun/packages/supervisor`; the Docker runtime provider, the studio's workspace side and the verification checks that C9 names are not built. It uses the token and confinement types of [`@delorun/contract-home-layout`](../contract-home-layout/README.md).

## Exports

- **Runtime provider:** `RUNTIME_PROVIDER_SERVICE`, and the `RuntimeProvider`, `RuntimeKind`, `DockerShape`, `WorkspaceRuntimeRequest`, `WorkspaceRuntimeSpec`, `WorkspaceRuntimeState` and `WorkspaceId` types.
- **Capability report:** `REQUIRED_LIMITS`, and the `CapabilityReport`, `DockerCapabilities`, `DockerLimit`, `LimitFinding`, `ShapeAvailability` and `ShapeReason` types.
- **Presets:** `PRESETS`, `DEFAULT_PRESET`, `ADVANCED_BOUNDS`, `GIB` and `MIB`, with the `PresetName` and `ResourceLimits` types.
- **Egress and credentials:** `DEFAULT_EGRESS`, `DEFAULT_EGRESS_HOSTS`, `MAX_ALLOWLIST_ADDITIONS`, `MAX_HOST_LENGTH`, `EGRESS_PROXY_PORT`, `EGRESS_PROXY_ENTRY` and `EGRESS_REFUSED_RANGES`, with the `EgressMode` and `CredentialOption` types.
- **Supervisor:** `SUPERVISOR_PROTOCOL_VERSION`, `SUPERVISOR_REQUEST_MAX_BYTES`, `SUPERVISOR_REQUEST_DEADLINE_MS`, `SUPERVISOR_MAX_CONNECTIONS`, `WORKSPACE_ID_MAX_LENGTH`, `ROOT_MAX_BYTES`, `GRACEFUL_STOP_MS`, `MAX_ROOT_PARENTS`, `LABELS` and `NAME_HASH_HEX_DIGITS`, with the `SupervisorRequest`, `SupervisorFailure`, `SupervisorErrorCode` and `SupervisorRoots` types.
- **Helper channel and S3:** `HELPER_KEY_BYTES`, `HELPER_CHALLENGE_LABEL`, `HELPER_CHALLENGE_TIMEOUT_MS`, `HELPER_SOCKET_DIR`, `AGENT_SOCKET_PATH` and `S3_USERS`.
- **Images:** `IMAGES`, `IMAGE_BASE` and `IMAGE_PULL_HOSTS`.
- **Denial marker:** `ENVIRONMENT_DENIAL_SIGNATURES` and `ENVIRONMENT_DENIAL_MARKER`.
