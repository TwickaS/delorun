---
description: "The Delo contract index: each contract page with its types package and the code that consumes it."
---

# Delo contracts

English | [中文](README.zh.md)

## Summary

A contract is a specification that work packages consume as written: the types, wire formats, limits, errors and security requirements that code consumes, with the denial tests that prove the requirements. Each contract page has a Security section that states its requirements and the denial tests for them, and a "What this does not prove" subsection where the page's claims have limits. Contract C12 (telemetry) is not part of the first release, so no page covers it.

## The contracts

| ID | Contract | Types package | Consumers |
| --- | --- | --- | --- |
| C1 | [C1 Home layout and runtime store](c01-home-layout.md) | [`@delo/contract-home-layout`](../../packages/contract-home-layout/README.md) | The `delorun` command, `delo/packages/integrity`, the install script and npm launcher, `delo/packages/runtime-store`, `delo/packages/home-process`, `delo/packages/supervisor`, `delo/packages/home-auth`; upstream's sandbox dialects |
| C2 | [C2 Release manifest and signature](c02-release-manifest.md) | [`@delo/contract-release-manifest`](../../packages/contract-release-manifest/README.md) | `delo/apps/release`, `delo/apps/install` and `delo/apps/npm-launcher`, `delo/packages/runtime-store`, the desktop updater, `delo/packages/integrity`, the Docker supervisor's image check, the catalogue's key |
| C3 | [C3 Update report](c03-update-report.md) | [`@delo/contract-update-report`](../../packages/contract-update-report/README.md) | `delo/packages/update`, upstream's profile and plugin manager restore, `delo/packages/profile-safety`, the studio's update screens and the desktop updater |
| C4 | [Contract C4: admission and listeners](c04-admission.md) | [`@delo/contract-admission`](../../packages/contract-admission/README.md) | Upstream's client connection and web server, the Trusted Types policies, `delo/packages/home-auth`, `delo/packages/reach` |
| C5 | [Contract C5: device approval](c05-device-approval.md) | [`@delo/contract-device-approval`](../../packages/contract-device-approval/README.md) | `delo/packages/home-auth`, `delo/packages/certificates`, `delo/packages/plugin-reach-ui`, the desktop app's connection to another home |
| C6 | [Contract C6: relay protocol](c06-relay-protocol.md) | [`@delo/contract-relay-protocol`](../../packages/contract-relay-protocol/README.md) | `delo/apps/relay`, `delo/packages/reach`, `delo/packages/certificates` |
| C7 | [Contract C7: reach providers](c07-reach-providers.md) | [`@delo/contract-reach-providers`](../../packages/contract-reach-providers/README.md) | `delo/packages/reach`, `delo/packages/certificates`, `delo/packages/plugin-reach-ui`, `delo/packages/home-auth` |
| C8 | [Contract C8: archive format v1 and trash](c08-archive-and-trash.md) | [`@delo/contract-archive-and-trash`](../../packages/contract-archive-and-trash/README.md) | `delo/packages/archive`, `delo/packages/trash`, the studio's trash screen, `delorun import` |
| C9 | [C9 Runtime and supervisor interface](c09-runtime-supervisor.md) | [`@delo/contract-runtime-supervisor`](../../packages/contract-runtime-supervisor/README.md) | `delo/packages/supervisor`, `delo/packages/runtime-docker`, the studio's workspace plugin, `delo/apps/release`, `delo/packages/integrity`; upstream's sandbox and PTC packages |
| C10 | [Contract C10: host-qualified keys](c10-host-qualified-keys.md) | [`@delo/contract-host-qualified-keys`](../../packages/contract-host-qualified-keys/README.md) | Upstream's client store and UI packages, `delo/packages/trash`, `delo/packages/plugin-workspaces` |
| C11 | [Contract C11: setup answers](c11-setup-answers.md) | [`@delo/contract-setup-answers`](../../packages/contract-setup-answers/README.md) | `delo/apps/cli` setup, `delo/packages/bundle-local`, `delo/packages/plugin-onboarding` |
| C13 | [C13 Catalogue index and revocation list](c13-catalogue-revocation.md) | [`@delo/contract-catalogue-revocation`](../../packages/contract-catalogue-revocation/README.md) | `Delo-Run/delo-plugins`, `delo/packages/catalogue`, Discover's configuration and studio plugin, `delorun verify`, the update report |
| C14 | [Contract C14: OpenID Connect and passkeys](c14-oidc-passkeys.md) | [`@delo/contract-oidc-passkeys`](../../packages/contract-oidc-passkeys/README.md) | `delo/packages/home-auth`, setup in `delo/apps/cli`, `delo/packages/plugin-reach-ui` |
| C15 | [Contract C15: verification checks and report](c15-verification-checks.md) | [`@delo/contract-verification-checks`](../../packages/contract-verification-checks/README.md) | `delo/packages/integrity`, `delo/apps/cli` (`delorun verify` and `delorun status`), the studio's Verification panel |
| C16 | [Contract C16: parity composition](c16-parity-composition.md) | [`@delo/contract-parity-composition`](../../packages/contract-parity-composition/README.md) | `delo/apps/tools` (replay lane, static scan, switch sweep), the packages that register switches, `packages/boot/doctor`, launched by `apps/cli`, upstream's snapshot configuration |
| C17 | [C17 Plugin version requirements](c17-plugin-versions.md) | [`@delo/contract-plugin-versions`](../../packages/contract-plugin-versions/README.md) | Upstream's app-boot plugin compatibility, `delo/apps/cli` version output, the update report, the catalogue corpus |
| C18 | [C18 Release log and witness](c18-release-log.md) | [`@delo/contract-release-log`](../../packages/contract-release-log/README.md) | `delo/apps/release`, `delo/apps/install` and `delo/apps/npm-launcher`, the CLI launcher and home process, the desktop updater, `delorun verify` |
| C19 | [C19 Home process and update handshake](c19-home-process.md) | [`@delo/contract-home-process`](../../packages/contract-home-process/README.md) | `delo/packages/home-process`, `delo/apps/cli`, `delo/packages/runtime-store`, `delo/packages/logs`, the Host's update plugin, the update report screens |
| C20 | [C20 Operational logs](c20-operational-logs.md) | [`@delo/contract-operational-logs`](../../packages/contract-operational-logs/README.md) | `delo/packages/logs`, `delo/apps/cli` (`delorun logs` and purge), `delo/packages/home-process`, `delo/packages/supervisor`, `delo/apps/relay`, upstream's desktop Host log |

## Changing a contract

A contract changes in the same change as the code that consumes it, and its types package changes in that same pull request. Each page's Compatibility section states what a change may do: a change that moves, renames or changes the meaning of an external interface is breaking and needs an upgrade guide under `delo/docs/upgrade-guide/`.
