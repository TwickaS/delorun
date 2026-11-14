---
description: "The Delorun contract index: each contract page with its types package and the code that consumes it."
---

# Delorun contracts

English | [中文](README.zh.md)

## Summary

A contract is a specification that work packages consume as written: the types, wire formats, limits, errors and security requirements that code consumes, with the denial tests that prove the requirements. Each contract page has a Status section that names what is built and reached, what is built and reached by nothing, and what is not built, a Security section that states its requirements and the denial tests for them, and a "What this does not prove" subsection where the page's claims have limits. A requirement the Status section names as not built protects no one; the [designs](../design/README.md) hold the rules of features that are not built. Contract C12 (telemetry) is not part of Delorun, so no page covers it.

## The contracts

| ID | Contract | Types package | Built | Consumers |
| --- | --- | --- | --- | --- |
| C1 | [C1 Home layout and runtime store](c01-home-layout.md) | [`@delorun/contract-home-layout`](../../packages/contract-home-layout/README.md) | Partly | The `delorun` command, `delorun/packages/home`, the npm launcher, `delorun/packages/runtime-store`, `delorun/packages/home-process`, `delorun/packages/supervisor`, `delorun/packages/home-auth`; upstream's sandbox dialects |
| C2 | [C2 Release manifest and signature](c02-release-manifest.md) | [`@delorun/contract-release-manifest`](../../packages/contract-release-manifest/README.md) | Partly | `delorun/apps/release`, `delorun/apps/install` and `delorun/apps/npm-launcher`, `delorun/packages/runtime-store`, `delorun verify`, the Docker supervisor's image check |
| C3 | [C3 Update report](c03-update-report.md) | [`@delorun/contract-update-report`](../../packages/contract-update-report/README.md) | Partly | `delorun/packages/update`, `delorun update` and `delorun recover`, upstream's profile and plugin manager restore, `delorun/packages/profile-safety` |
| C4 | [Contract C4: admission and listeners](c04-admission.md) | [`@delorun/contract-admission`](../../packages/contract-admission/README.md) | Partly: loopback only | Upstream's client connection and web server, the Trusted Types policies, `delorun/packages/home-auth` |
| C5 | [Contract C5: device approval](c05-device-approval.md) | [`@delorun/contract-device-approval`](../../packages/contract-device-approval/README.md) | No | `delorun/packages/home-auth` |
| C6 | [Contract C6: relay protocol](c06-relay-protocol.md) | [`@delorun/contract-relay-protocol`](../../packages/contract-relay-protocol/README.md) | Relay server only | `delorun/apps/relay` |
| C7 | [Contract C7: reach providers](c07-reach-providers.md) | [`@delorun/contract-reach-providers`](../../packages/contract-reach-providers/README.md) | No | None |
| C8 | [Contract C8: archive format v1 and trash](c08-archive-and-trash.md) | [`@delorun/contract-archive-and-trash`](../../packages/contract-archive-and-trash/README.md) | Partly | `delorun/packages/archive`, `delorun/packages/trash`, `delorun/packages/plugin-trash`, `delorun export`, `delorun import` and `delorun trash` |
| C9 | [C9 Runtime and supervisor interface](c09-runtime-supervisor.md) | [`@delorun/contract-runtime-supervisor`](../../packages/contract-runtime-supervisor/README.md) | Reached by nothing | `delorun/packages/supervisor`, `delorun/apps/release`; upstream's sandbox and PTC packages |
| C10 | [Contract C10: host-qualified keys](c10-host-qualified-keys.md) | [`@delorun/contract-host-qualified-keys`](../../packages/contract-host-qualified-keys/README.md) | Partly | Upstream's client store and UI packages, `delorun/packages/trash` |
| C11 | [Contract C11: setup answers](c11-setup-answers.md) | [`@delorun/contract-setup-answers`](../../packages/contract-setup-answers/README.md) | Partly | `delorun/apps/cli` setup, `delorun/packages/bundle-local`, `delorun/packages/plugin-onboarding` |
| C13 | [C13 Catalogue index and revocation list](c13-catalogue-revocation.md) | [`@delorun/contract-catalogue-revocation`](../../packages/contract-catalogue-revocation/README.md) | No | `delorun update`'s report, which records the revocation list as not checked |
| C14 | [Contract C14: OpenID Connect and passkeys](c14-oidc-passkeys.md) | [`@delorun/contract-oidc-passkeys`](../../packages/contract-oidc-passkeys/README.md) | No | None |
| C15 | [Contract C15: verification checks and report](c15-verification-checks.md) | [`@delorun/contract-verification-checks`](../../packages/contract-verification-checks/README.md) | Partly: two checks | `delorun verify` |
| C16 | [Contract C16: parity composition](c16-parity-composition.md) | [`@delorun/contract-parity-composition`](../../packages/contract-parity-composition/README.md) | Partly | `delorun/apps/tools` (replay lane, static scan, switch sweep), the packages that register switches, `packages/boot/doctor`, launched by `apps/cli`, upstream's snapshot configuration |
| C17 | [C17 Plugin version requirements](c17-plugin-versions.md) | [`@delorun/contract-plugin-versions`](../../packages/contract-plugin-versions/README.md) | Partly | Upstream's app-boot plugin compatibility, `delorun/apps/cli` version output, the update report |
| C18 | [C18 Release log and witness](c18-release-log.md) | [`@delorun/contract-release-log`](../../packages/contract-release-log/README.md) | Partly | `delorun/apps/release`, `delorun/apps/install` and `delorun/apps/npm-launcher`, `delorun/packages/release-verify`, `delorun verify` |
| C19 | [C19 Home process and update handshake](c19-home-process.md) | [`@delorun/contract-home-process`](../../packages/contract-home-process/README.md) | Partly | `delorun/packages/home-process`, `delorun/apps/cli`, `delorun/packages/runtime-store`, `delorun/packages/logs` |
| C20 | [C20 Operational logs](c20-operational-logs.md) | [`@delorun/contract-operational-logs`](../../packages/contract-operational-logs/README.md) | Partly | `delorun/packages/logs`, `delorun/apps/cli` (`delorun logs` and purge), `delorun/packages/home-process`, `delorun/apps/relay` |
| C21 | [C21 Changes](c21-changes.md) | [`@delorun/changes`](../../packages/changes/README.md) | Partly | `delorun/apps/cli` (`delorun start`, `headless`, `changes`, `verify`, `doctor`), `delorun/packages/home-process`, `delorun/packages/plugin-changes`, `delorun/packages/plugin-instruction-consent` |
| C22 | [C22 What a Delorun version promises a plugin](c22-delorun-plugin-interface.md) | [`@delorun/contract-plugin-versions`](../../packages/contract-plugin-versions/README.md) | Partly | `delorun/apps/release` (the patch rule), `delorun/apps/cli` (`delorun plugin check`), plugin authors |

## Changing a contract

A contract changes in the same change as the code that consumes it, and its types package changes in that same pull request. Each page's Compatibility section states what a change may do: a change that moves, renames or changes the meaning of an external interface is breaking and needs an upgrade guide under `delorun/docs/upgrade-guide/`.
