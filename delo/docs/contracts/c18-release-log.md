---
description: "Contract C18: how every Delo release manifest is logged in Sigstore's public Rekor log, the witness cosignature clients require on its checkpoints, the release-log bundle format, how the launcher, delorun verify and the desktop updater check inclusion, and what a start without network does."
---

# C18 Release log and witness

English | [中文](c18-release-log.zh.md)

## Summary

Every signed release manifest of [C2](c02-release-manifest.md) has an entry in Sigstore's public Rekor log, an append-only transparency log that Delo does not operate. Rekor signs checkpoints of its tree, and an independent witness from the public witness network cosigns them, so a log that showed one client a different history from another would be caught by the witness. Each release publishes a bundle with the entry, its inclusion proof and a witnessed checkpoint. Clients refuse an entry without a valid witness cosignature. Installing a release always requires a verified inclusion proof; a start without network starts with a warning naming the unchecked release and checks at the next connection. The types live in [`@delo/contract-release-log`](../../packages/contract-release-log/README.md).

## Contents

- [The log and the witness](#the-log-and-the-witness)
- [Log entry](#log-entry)
- [Release-log bundle](#release-log-bundle)
- [Verifying a bundle](#verifying-a-bundle)
- [Consistency with the current log](#consistency-with-the-current-log)
- [Check states](#check-states)
- [Behaviour per client](#behaviour-per-client)
- [Values and limits](#values-and-limits)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)

## The log and the witness

- The log is Sigstore's public Rekor instance. Its checkpoint origin line and its checkpoint verifier key are in the root metadata's `log` field ([C2](c02-release-manifest.md#root-metadata)), so they change only by a root rotation.
- Checkpoints use the C2SP signed-note format (`tlog-checkpoint`); witness cosignatures use C2SP `tlog-cosignature` (`cosignature/v1`), whose signed message includes the cosigning time.
- The witnesses are keys of witnesses in the public witness network, listed in the root metadata's `witnesses.keys` with `witnesses.threshold` 1: a checkpoint is witnessed when at least 1 listed witness cosigned it. Delo operates none of them.
- Delo publishes nothing to the log except the entries of its release manifests and re-signed manifests.

## Log entry

One entry per signed manifest file, written by the release workflow after the targets key signs and before the release is published:

| Entry field | Value |
| --- | --- |
| Type | `hashedrekord` |
| Artifact digest | SHA-256 of the manifest file's bytes (the whole envelope) |
| Signature | The targets key's Ed25519 signature over the manifest file's bytes |
| Public key | The active targets public key, in PKIX PEM |

A re-signed manifest after a targets-key revocation ([C2](c02-release-manifest.md#key-rotation)) gets its own entry. A release is "logged" when its manifest file's entry verifies as this page states.

## Release-log bundle

`delorun-<version>.manifest.log.json`, schema `delo.release-log-bundle/1`, unsigned (every part carries its own signature):

| Field | Type | Meaning |
| --- | --- | --- |
| `manifest` | `{ "name", "sha256" }` | The manifest file this bundle covers. |
| `entry` | `{ "logIndex", "integratedTime", "body" }` | The entry as Rekor returned it; `body` is the base64 canonical entry. |
| `inclusion` | `{ "treeSize", "rootHash", "hashes": [hex...], "logIndex" }` | The RFC 6962 inclusion proof of the entry's leaf in that tree. |
| `checkpoint` | string | The signed-note checkpoint for `treeSize` and `rootHash`, with Rekor's signature and at least 1 witness cosignature line. |

The release workflow publishes the bundle on GitHub Releases beside the manifest, after a witness has cosigned a checkpoint at or above the entry's tree size. A release is not published before its bundle verifies.

## Verifying a bundle

A bundle verifies when all of these hold, with the keys of the client's current trusted root:

1. `manifest.sha256` equals the SHA-256 of the manifest file the client verified under [C2](c02-release-manifest.md).
2. The entry body is a `hashedrekord` whose digest equals that SHA-256 and whose signature verifies with a targets key that is valid for the release.
3. The leaf hash of the entry body, the inclusion proof and `treeSize` reproduce `rootHash`.
4. The checkpoint names the root metadata's log origin, its `treeSize` and `rootHash` match the proof, and its log signature verifies with the log's verifier key.
5. Cosignatures from at least `witnesses.threshold` distinct listed witness keys verify over that checkpoint.

A bundle without a valid witness cosignature fails step 5 and the entry is refused, whatever the log signature says.

## Consistency with the current log

A verified bundle shows the entry was in the log at the checkpoint it carries. The online check also shows that the client's view of the log agrees with what the witnesses saw since:

1. The client fetches the log's latest checkpoint with its witness cosignatures from the witness network's checkpoint distributor.
2. It requires a valid log signature, at least `witnesses.threshold` valid listed cosignatures, and a newest cosigning time at most 24 hours before the client's clock.
3. It fetches an RFC 6962 consistency proof from the bundle's (or its stored) checkpoint to the latest one from the log and verifies it.
4. It stores the latest verified checkpoint, so the next check proves consistency from it.

When the client cannot reach the distributor or the log, or the latest witnessed checkpoint is older than 24 hours, the online check is not done and the release stays `unchecked`; that is not a failure. A verifiable failure (a bad signature, a missing witness cosignature, a consistency proof that does not verify, a checkpoint smaller than the stored one) is `failed`.

## Check states

| State | Meaning |
| --- | --- |
| `verified` | The bundle verifies and the online check passed at least once for this installation. |
| `unchecked` | The online check has not passed yet because the log or distributor was not reachable; the bundle, if present, verifies. |
| `failed` | The bundle or the online check failed verifiably. |

The state is stored per installed release at the path [C1](c01-home-layout.md) names, and `delorun verify`, `delorun status` and the studio's Verification panel show it with the release's version ([C15](c15-verification-checks.md)).

Under `integrity.mode: off` ([C15](c15-verification-checks.md#modes)), the online check does not run. A release whose bundle verifies offline then stays `unchecked`, and the start warning and retries do not apply. The offline verification still runs at each start, and a verified failure of it stops the start in every mode, as R5 requires.

## Behaviour per client

| Client | Install or update | Start |
| --- | --- | --- |
| npm launcher and install script | Require a verified bundle and a passing online check; otherwise nothing installs. | — |
| `delorun update` and the studio's "Update now" | Require a verified bundle and a passing online check for the target; otherwise the update is refused with the reason. | — |
| CLI launcher, at every start | — | Verifies the stored bundle offline. With network, runs the online check. Without network, starts with the warning "Release <version> has not been checked against the release log; Delo checks it at the next connection." and records `unchecked`. On `failed`, stops in every verification mode and offers rollback. |
| Headless home | — | As the CLI launcher; the warning goes to the terminal, the operational log ([C20](c20-operational-logs.md)) and `delorun status`. |
| Home process while running | — | While the state is `unchecked`, retries the online check every 15 minutes and at every start until it passes or fails. |
| Desktop updater | Requires a verified bundle and a passing online check before `quitAndInstall`, and for a requested rollback target. | At start, verifies its release's bundle when stored and runs the online check; without network, shows the same warning in the app and retries every 15 minutes. |
| `delorun verify` | — | Reports `verified`, `unchecked` or `failed` for the active release, and fails on `failed` or on a missing bundle. |

The first start of a desktop app installed from a downloaded installer has no stored bundle; it fetches the bundle from GitHub Releases, and without network it starts `unchecked` with the warning.

## Values and limits

| Value | Number |
| --- | --- |
| Witness threshold | 1 listed witness |
| Maximum age of the latest witnessed checkpoint for the online check | 24 hours |
| Retry interval while `unchecked` | 15 minutes |
| Bundle size limit before parsing | 64 KiB |
| Inclusion and consistency proof length | at most 64 hashes |
| Request timeout to the log and the distributor | 30 seconds |

## Consumers

- `delo/apps/release/` (WP3.1): writes the entry, waits for a witnessed checkpoint and publishes the bundle.
- `delo/apps/install/` and `delo/apps/npm-launcher/` (WP3.2): require the bundle and the online check before installing.
- The CLI launcher and the home process (WP2.11, WP3.9): the start check, the warning and the retries.
- The desktop updater (WP6.3).
- `delorun verify` and the Verification panel ([C15](c15-verification-checks.md)).

## Compatibility

The bundle's `schema` names its major version. The log's origin and key and the witness keys change only through a root rotation ([C2](c02-release-manifest.md#key-rotation)), so a client never accepts a new log or witness from the network alone. Moving to another Rekor instance or another entry type is a new root version plus a new bundle major version, and releases publish both bundle versions while older clients are supported.

## Security

### Requirements

- R1. Every manifest file, re-signed ones included, has a log entry before its release is published.
- R2. A client refuses an entry whose checkpoint lacks a valid cosignature from a listed witness.
- R3. Installing or updating, and a requested desktop rollback, require a verified bundle and a passing online check.
- R4. A start without network starts with a warning that names the unchecked release, records `unchecked`, and checks at the next connection.
- R5. A verifiable log failure stops the CLI start in every verification mode and fails `delorun verify`.
- R6. The log key and the witness keys are trusted only from the root metadata.
- R7. The stored checkpoint never moves backwards: a smaller or inconsistent checkpoint is `failed`.

### Denial tests

| Test | Owner | Behaviour it shows |
| --- | --- | --- |
| `c18-missing-witness-fails-verify` | WP3.1, WP3.2 | A release whose bundle's checkpoint carries no witness cosignature fails `delorun verify` and is not installed. |
| `c18-unlisted-witness-refused` | WP3.2 | A cosignature from a key outside `witnesses.keys` does not count, and the bundle fails. |
| `c18-wrong-inclusion-proof-refused` | WP3.2 | A bundle whose proof does not reproduce `rootHash` is refused before installation. |
| `c18-entry-for-other-manifest-refused` | WP3.2 | A valid entry for a different manifest digest is refused. |
| `c18-offline-start-warns` | WP2.11, WP3.9 | A start with the log and distributor stand-ins unreachable starts, prints the warning with the release's version and records `unchecked`. |
| `c18-offline-recheck-on-connect` | WP3.9 | After the stand-ins become reachable, the home process's next retry records `verified`. |
| `c18-offline-update-refused` | WP3.2, WP3.9, WP6.3 | An update attempted while the log is unreachable is refused, and the running version stays. |
| `c18-inconsistent-log-fails-start` | WP2.11 | A latest checkpoint whose consistency proof from the stored checkpoint does not verify records `failed` and stops the start in every verification mode. |
| `c18-checkpoint-rollback-refused` | WP2.11 | A witnessed checkpoint with a smaller tree size than the stored one records `failed`. |
| `c18-desktop-refuses-unlogged-update` | WP6.3 | A desktop update whose bundle fails is refused before `quitAndInstall`. |

### What this does not prove

- **Witness independence.** A client verifies that a witness key listed in the root metadata cosigned the checkpoint. It cannot verify that the witness is operated independently of the log or of Delo; that rests on which witnesses the root metadata lists.
- **An offline home.** A home that never reaches the log and the distributor stays `unchecked` and keeps starting with the warning. It never completes the consistency check, so a different view of the log shown to it is not detected until it connects; installing or updating still requires the check.
- **Clock dependence.** The 24-hour limit on the latest witnessed checkpoint's age uses the client's clock; a wrong clock can accept an older checkpoint or record `unchecked` for a current one.
- **What a log entry means.** A verified entry shows that the manifest was published in a log every client can check; it does not show that the release is free of defects or vulnerabilities.
