---
description: "Contract C18: how every Delorun release manifest is logged in Sigstore's public Rekor log, the witness cosignature clients require on its checkpoints, the release-log bundle format, how the launcher, delorun verify and the desktop updater check inclusion, and what a start without network does."
---

# C18 Release log and witness

English | [中文](c18-release-log.zh.md)

## Summary

Every signed release manifest of [C2](c02-release-manifest.md) has an entry in Sigstore's public Rekor log, an append-only transparency log that Delorun does not operate. Rekor signs checkpoints of its tree, and an independent witness from the public witness network cosigns them, so a log that showed one client a different history from another would be caught by the witness. Each release publishes a bundle with the entry, its inclusion proof and a witnessed checkpoint. Clients refuse a bundle whose checkpoint carries no valid witness cosignature; a latest checkpoint the log serves without one only leaves the release unchecked, with a warning. Installing a release always requires a verified inclusion proof. When the log cannot be reached, gives no checkpoint its key signed, its latest checkpoint lacks the witness's cosignature, or its newest cosignature is stale, an install or update warns, continues on the release's signature and records that the online check did not run; a log whose signed checkpoint then contradicts the release, or a witness cosignature that is present and invalid, refuses. `delorun update` shows the recorded state in its report, and `--yes` does not confirm a release left unchecked. A start without network starts with a warning naming the unchecked release and checks at the next connection; a release the runtime store installed whose stored bundle is missing stops the start, because every such install keeps the bundle it verified. The types live in [`@delorun/contract-release-log`](../../packages/contract-release-log/README.md).

## Status

The bundle format, its verification and the online check are built and reached at install, at every launcher start and by `delorun verify`; publishing is a command a person runs, and the running home's retries, the desktop updater and the mode switch are not built.

- **Built and reached:** the npm launcher and `delorun update` require a verified bundle and run the online check before anything installs; the launcher verifies the stored bundle and runs the online check at every start, warns and continues on `unchecked` and stops on `failed` or a missing stored bundle; `delorun verify` reports the state. The release's `log-release` command writes the entry and writes the bundle only after it verifies with the root's log and witness keys.
- **Not built:** a release workflow in this repository that runs the log command and publishes the bundle, so publishing after verification rests on the person who runs the commands; the running home process's retry every 15 minutes, because the start check runs only in the launcher; the start warning in the operational log and in `delorun status`, which shows no release-log state; the studio's "Update now" and Verification panel; the desktop updater's checks; `integrity.mode: off`, which nothing reads, so the online check always runs.

The requirements and denial tests below that this list names as not built or reached by nothing protect no one until a change builds and wires them.

## Contents

- [Status](#status)
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

- The log is a shard of Sigstore's public Rekor v2 log, which signs its checkpoints with an Ed25519 note key. Its checkpoint origin line and its checkpoint verifier key are in the root metadata's `log` field ([C2](c02-release-manifest.md#root-metadata)), so they change only by a root rotation.
- Checkpoints use the C2SP signed-note format (`tlog-checkpoint`); witness cosignatures use C2SP `tlog-cosignature` (`cosignature/v1`), whose signed message includes the cosigning time.
- The witnesses are keys of witnesses in the public witness network, listed in the root metadata's `witnesses.keys` with `witnesses.threshold` 1: a checkpoint is witnessed when at least 1 listed witness cosigned it. Delorun operates none of them.
- Delorun publishes nothing to the log except the entries of its release manifests and re-signed manifests.

## Log entry

One entry per signed manifest file, submitted by the release's signing command after the targets key signs and before the release is published. The entry is signed by an `active` key the trusted root lists in `logEntryKeys` ([C2](c02-release-manifest.md#root-metadata)): ECDSA P-256 first, with Ed25519ph by the targets key as the listed alternative. A root without the list, such as `1.root.json`, verifies no release.

| Entry field | Value |
| --- | --- |
| Type | `hashedrekord`, API version `0.0.2` (Rekor v2) |
| Key details | The entry key type: `PKIX_ED25519_PH` or `PKIX_ECDSA_P256_SHA_256` |
| Digest | The key type's digest of the manifest file's bytes (the whole envelope): SHA-512, algorithm `SHA2_512`, for `PKIX_ED25519_PH`; SHA-256, algorithm `SHA2_256`, for `PKIX_ECDSA_P256_SHA_256` |
| Signature | Over the manifest file's bytes: Ed25519ph (RFC 8032, empty context) for `PKIX_ED25519_PH`; ECDSA P-256 with SHA-256, DER-encoded, for `PKIX_ECDSA_P256_SHA_256` |
| Public key | The signing key's DER-encoded PKIX public key |

The signing command submits these fields as a `hashedRekordRequestV002` to the log's `/api/v2/log/entries`; the log builds the entry body from them, and the log's leaf is the RFC 8785 serialisation of that body. Rekor v2 accepts an Ed25519 key only with Ed25519ph, so the log refuses a pure Ed25519 (`PKIX_ED25519`) entry, and clients refuse one too.

The signing command tries the root's listed `active` keys it holds in the root's order. Before each submission it verifies its own request as step 2 below does, under the root it signs for, and submits nothing that does not verify. It moves to the next key only when the log answers HTTP 400 with a JSON body whose `message` is exactly `invalid hashedrekord request` (Rekor v2) or `entry algorithms are not allowed` (Rekor v1), which is how a log refuses an entry key type; any other answer stops the release. The log accepting an entry proves nothing by itself: the bundle the command writes must verify as this page states. Before a cut, `apps/release/scripts/probe-log.ts` submits one entry over random bytes per listed `active` type, each signed by a throwaway key, and reports which types the log accepts.

A re-signed manifest after a targets-key revocation ([C2](c02-release-manifest.md#key-rotation)) gets its own entry. A release is "logged" when its manifest file's entry verifies as this page states.

## Release-log bundle

`delorun-<version>.manifest.log.json`, schema `delorun.release-log-bundle/1`, unsigned (every part carries its own signature):

| Field | Type | Meaning |
| --- | --- | --- |
| `manifest` | `{ "name", "sha256" }` | The manifest file this bundle covers. |
| `entry` | `{ "logIndex", "integratedTime", "body" }` | The entry as Rekor returned it; `body` is the base64 canonical entry body. Rekor v2 records no integration time, so `integratedTime` is 0. |
| `inclusion` | `{ "treeSize", "rootHash", "hashes": [hex...], "logIndex" }` | The RFC 6962 inclusion proof of the entry's leaf in that tree. |
| `checkpoint` | string | The signed-note checkpoint for `treeSize` and `rootHash`, with Rekor's signature and at least 1 witness cosignature line. |

The bundle is published on GitHub Releases beside the manifest. The `log-release` command writes it only after a witness has cosigned a checkpoint at or above the entry's tree size and the bundle verifies; no workflow in this repository publishes a release, so the rule that a release is not published before its bundle verifies rests on the person who publishes it.

## Verifying a bundle

A bundle verifies when all of these hold, with the keys of the client's current trusted root:

1. `manifest.sha256` equals the SHA-256 of the manifest file the client verified under [C2](c02-release-manifest.md).
2. The entry body is a Rekor v2 `hashedrekord` (`0.0.2`), the root lists `logEntryKeys` (`entry-key-untrusted` otherwise), the entry's key details are a listed type this client implements (`entry-type-refused` otherwise), its public key is byte for byte a listed key of that type that is `active`, or `retired` with a `lastRelease` at or above the version of the signed manifest, never a version the bundle names (`entry-key-untrusted` otherwise, and always for a `revoked` key), its digest algorithm and digest are the type's over the manifest file, and its signature over the manifest file verifies with that listed key.
3. The leaf hash of the entry body, the inclusion proof and `treeSize` reproduce `rootHash`.
4. The checkpoint names the origin of a log the root lists in `logs` (`log-origin-untrusted` otherwise, and always under a root without `logs`), its `treeSize` and `rootHash` match the proof, and its log signature verifies with that log's Ed25519 verifier key.
5. Cosignatures from at least `witnesses.threshold` distinct listed witness keys verify over that checkpoint, whichever listed log signed it.

A bundle without a valid witness cosignature fails step 5 and the entry is refused, whatever the log signature says.

## Consistency with the current log

A verified bundle shows the entry was in the log at the checkpoint it carries. The online check also shows that the client's view of the log agrees with what the witnesses saw since:

1. The client fetches the log's latest checkpoint, with its witness cosignatures, from the log itself: `GET https://<log origin>/api/v2/checkpoint`, where `<log origin>` is the root metadata's `log.origin`. Rekor v2 serves the witnessed checkpoint there, and there is no separate distributor.
2. It requires a valid log signature with the root's log key; until one verifies, nothing the log answered is signed. Each cosignature from a listed witness that is present must verify; a listed witness that has not cosigned is absent, which is not an error. A cosignature dated more than 5 minutes after the client's clock is not counted, because a slow clock cannot be told from a witness that dates ahead. It then wants at least `witnesses.threshold` counted cosignatures, with a newest cosigning time at most 24 hours before the client's clock.
3. It computes the RFC 6962 consistency proof from the bundle's (or its stored) checkpoint to the latest one from the log's tiles, `GET https://<log origin>/api/v2/tile/<L>/<N>` and the partial tiles `<N>.p/<W>` (C2SP `tlog-tiles`; the log has no proof endpoint), and verifies it against the two checkpoints' root hashes.
4. It stores the latest verified checkpoint as the signed note with its tree size and root hash in `trust/checkpoint.json`, so the next check proves consistency from it. A stored checkpoint is read only when its note carries a valid signature of the root's log key and its fields match the note.

One rule sorts every outcome: anything before the checkpoint's log signature verifies leaves the release `unchecked`, and once it verifies, anything that does not hold together is `failed`. So no answer, a request past its 30-second timeout, a whole check past its 90-second deadline, a `5xx`, a `404` or `410`, a redirect to another host or an answer over its size limit for the checkpoint, and a body that is not a checkpoint the root's log key signed (a proxy's page, another log's note) leave the release `unchecked`; that is not a failure. A signed checkpoint smaller than the stored one, a consistency proof that does not verify, a tile that the signed tree size says exists answering `404` or `410`, with the wrong length, with more bytes than its format allows or with a redirect to another host, and a cosignature from a listed witness that is present and does not verify are `failed`. A latest checkpoint with fewer than `witnesses.threshold` counted listed cosignatures (one dated more than 5 minutes in the future is not counted, and the `detail` names it and the client's clock), or whose newest cosignature is older than 24 hours, leaves the release `unchecked`, and only after the rollback and consistency checks, so a log that contradicts the release cannot avoid them by leaving the cosignature out. The failure code of a present invalid cosignature is `witness-cosignature-missing`, and the check's `detail` says which witness and why. A failure of the client's own code is reported as an error of the client, never as an unreachable log.

An install or update that finds `unchecked` goes on with the release's signature alone and tells the person so. The launcher marks the step "Release log not checked" with `!` and the reason, then prints the warning "Release <version> has not been checked against the release log; Delorun checks it at the next connection." It records the release as `unchecked`, with the reason as `detail`, in the check state file once the runtime store has installed the release; a release the store refuses leaves no record. Whoever can block a person's connection to the log and its witness leaves that person with the signature alone; the inclusion proof in the release's own bundle is still verified, offline, before anything installs. An install or update that finds `failed` installs nothing and records no check state. The roots and the timestamp it verified, and the checkpoint a passing check verified, stay recorded under `trust/`, because a later install holds the root chain, the timestamp and the log to what they proved.

The online check reads only the current log, the root's `log`. A release whose bundle's checkpoint is in an earlier log the root lists is verified offline at install and at each start and stays `unchecked` online, with a `detail` that names both logs.

A `trust/checkpoint.json` an earlier install wrote with only a tree size and a root hash, and no signed note, is a floor the client cannot check by itself. The online check keeps it only when a consistency proof from it to the log's signed latest checkpoint verifies, and the verified checkpoint then replaces the file. When the proof does not verify, it sets no floor, the verified checkpoint replaces it, and the attempt records a notice naming its tree size; when the log cannot be reached, the file stays as it is. A `trust/checkpoint.json` that does not read at all sets no floor either: the floor starts again from the release's own checkpoint, and the attempt records a notice saying so, naming any releases the home recorded as `verified`, so a reset is never silent.

## Check states

| State | Meaning |
| --- | --- |
| `verified` | The bundle verifies and the online check passed at least once for this installation. |
| `unchecked` | The online check has not passed: the log was not reachable, gave no checkpoint its key signed, or its witnesses had not cosigned its latest checkpoint within 24 hours; the bundle, if present, verifies. |
| `failed` | The bundle or the online check failed verifiably. |

The state is stored per installed release in `trust/release-log.json` (schema `delorun.release-log-state/1`, one entry per release with its `state`, `lastAttempt`, for `unchecked` the reason as `detail` and the first attempt of the current `unchecked` run as `uncheckedSince`, and the attempt's `notices`, such as a stored checkpoint that did not read), beside the checkpoint [C1](c01-home-layout.md) names. An install records `verified` or `unchecked` for the release it installs, and the start check updates the same entry. `delorun verify` shows it with the release's version ([C15](c15-verification-checks.md)); `delorun status` and the studio show no release-log state.

Under `integrity.mode: off` ([C15](c15-verification-checks.md#modes)), the online check does not run. Nothing reads `integrity.mode`, and the launcher always runs the online check. A release whose bundle verifies offline then stays `unchecked`, and the start warning and retries do not apply. The offline verification still runs at each start, and a verified failure of it stops the start in every mode, as R5 requires.

## Behaviour per client

| Client | Install or update | Start |
| --- | --- | --- |
| npm launcher and install script | Require a verified bundle. With the online check passed, install and record `verified`. With it `unchecked`, print the reason and the warning, install, and record `unchecked`. With it `failed`, install nothing. | — |
| `delorun update` and the studio's "Update now" | Require a verified bundle for the target, and treat the online check as the launcher does: `unchecked` warns, continues and records, `failed` refuses the update with the reason. The update report shows the recorded state, and `--yes` does not confirm `unchecked`. | — |
| CLI launcher, at every start | — | Verifies the stored bundle offline. With network, runs the online check. Without network, starts with the warning "Release <version> has not been checked against the release log; Delorun checks it at the next connection." and records `unchecked`. On `failed`, or with no stored bundle for a release the runtime store installed, stops in every verification mode and offers rollback. |
| Headless home | — | As the CLI launcher; the warning goes to the terminal, the operational log ([C20](c20-operational-logs.md)) and `delorun status`. |
| Home process while running | — | While the state is `unchecked`, retries the online check every 15 minutes and at every start until it passes or fails. |
| Desktop updater | Requires a verified bundle before `quitAndInstall`, and for a requested rollback target; an online check that is `unchecked` warns and records, and one that is `failed` refuses. | At start, verifies its release's bundle when stored and runs the online check; without network, shows the same warning in the app and retries every 15 minutes. |
| `delorun verify` | — | Reports `verified`, `unchecked` or `failed` for the active release, and fails on `failed` or on a missing bundle. It anchors the stored root on the roots the launcher that started it ships, which the launcher names in `DELORUN_LAUNCHER_ROOTS`, through the chain an install walked; without them it holds the root to its own signatures only and does not report the release signature as passed. It says since when a release has stayed `unchecked`, and exits 0 only when no check failed and the release signature passed or fell short only because the online check could not complete. |

The first start of a desktop app installed from a downloaded installer has no stored bundle; it fetches the bundle from GitHub Releases, and without network it starts `unchecked` with the warning.

## Values and limits

| Value | Number |
| --- | --- |
| Witness threshold | 1 listed witness |
| Maximum age of the latest witnessed checkpoint for the online check | 24 hours |
| Largest forward difference between a cosignature's time and the client's clock before it is not counted | 5 minutes |
| Retry interval while `unchecked` | 15 minutes |
| Bundle size limit before parsing | 64 KiB |
| Inclusion and consistency proof length | at most 64 hashes |
| Request timeout to the log | 30 seconds a request |
| Deadline of one whole online check, every request and redirect included | 90 seconds |

## Consumers

- `delorun/apps/release/`: writes the entry, waits for a witnessed checkpoint and publishes the bundle.
- `delorun/apps/install/` and `delorun/apps/npm-launcher/`: require the bundle and the online check before installing.
- The CLI launcher and the home process: the start check, the warning and the retries.
- The desktop updater.
- `delorun verify` and the Verification panel ([C15](c15-verification-checks.md)).

## Compatibility

The bundle's `schema` names its major version. The log's origin and key and the witness keys change only through a root rotation ([C2](c02-release-manifest.md#key-rotation)), so a client never accepts a new log or witness from the network alone. Moving to another Rekor instance or another entry type is a new root version plus a new bundle major version, and releases publish both bundle versions while older clients are supported. When a log shard that a root names stops serving, the online check of every release under that root stays `unchecked` for good, with the warning, and never becomes `failed`; a root rotation to the new shard and a release logged there end it.

## Security

### Requirements

- R1. Every manifest file, re-signed ones included, has a log entry before its release is published.
- R2. A client refuses a bundle whose checkpoint lacks a valid cosignature from a listed witness. The online check differs: a latest checkpoint that no listed witness has cosigned leaves the release `unchecked`, and a present cosignature that is invalid is `failed`, and one dated beyond the clock skew in the future is not counted.
- R3. Installing or updating, and a requested desktop rollback, require a verified bundle. An online check that could not run (`unchecked`) does not stop them: they warn, continue on the signature and record that the check did not run. An online check that failed verifiably stops them.
- R4. A start without network starts with a warning that names the unchecked release, records `unchecked`, and checks at the next connection.
- R5. A verifiable log failure stops the CLI start in every verification mode and fails `delorun verify`.
- R6. The log key and the witness keys are trusted only from the root metadata.
- R7. The stored checkpoint never moves backwards: a smaller or inconsistent checkpoint is `failed`.

### Denial tests

| Test | Component | Behaviour it shows |
| --- | --- | --- |
| `c18-missing-witness-fails-verify` | `release`, `install` | A release whose bundle's checkpoint carries no witness cosignature fails `delorun verify` and is not installed. |
| `c18-store-install-missing-bundle-fails` | release-chain | A release the runtime store installed whose stored bundle is missing records `failed` (`bundle-malformed`) and stops the start in every mode; a client that fetches its bundle after installing records `unchecked`. |
| `c18-unlisted-witness-refused` | `install` | A cosignature from a key outside `witnesses.keys` does not count, and the bundle fails. |
| `c18-wrong-inclusion-proof-refused` | `install` | A bundle whose proof does not reproduce `rootHash` is refused before installation. |
| `c18-entry-for-other-manifest-refused` | `install` | A valid entry for a different manifest digest is refused. |
| `c18-pure-ed25519-entry-refused` | `release`, `install` | An entry with a pure Ed25519 signature or `PKIX_ED25519` key details is refused; the same manifest's Ed25519ph entry verifies. |
| `c18-root-without-log-trust-refused` | `release-verify`, `install` | Under a root without `logEntryKeys`, even an Ed25519ph entry by its targets key is refused; under a root without `logs`, every checkpoint is. |
| `c18-listed-entries-only` | `release-verify` | A root that lists only an ECDSA P-256 key refuses an Ed25519ph entry by its targets key. |
| `c18-revoked-entry-key-refused` | `release-verify` | A revoked log-entry key verifies no release, an older one too, whatever `lastRelease` it carries. |
| `c18-retired-entry-key-by-signed-version` | `release-verify`, `install` | A retired log-entry key verifies a release up to its `lastRelease` by the signed manifest's version; a bundle that names the old release for a newer manifest is refused. |
| `c18-listed-log-needs-witness` | `release-verify` | A checkpoint of an earlier log the root lists, with no cosignature from a listed witness, is refused. |
| `c18-unlisted-entry-type-refused` | `release-verify` | An entry whose key type the root does not list is refused whatever its signature, in each direction between the two types. |
| `c18-listed-type-other-key-refused` | `release-verify`, `install` | An entry of a listed type whose key is not a listed key of that type is refused, and one naming the listed key with another key's signature is refused. |
| `c18-unlisted-log-origin-refused` | `release-verify` | A bundle whose checkpoint is in a log the root does not list is refused; one in an earlier log the root lists verifies only with that log's key. |
| `log-fallback-only-on-type-refusal` | `release` | A log answering the first entry with a 400 whose body is not one of the two refusal messages, a 5xx or a 409 stops the release with no other key tried and the channel unchanged. |
| `log-fallback-verifies-success` | `release` | A log that refuses the first type and accepts the second with an entry that is not the release's leaves the release unwritten. |
| `c18-offline-start-warns` | CLI launcher, home process | A start with the log stand-in unreachable starts, prints the warning with the release's version and records `unchecked`. |
| `c18-offline-recheck-on-connect` | home process | After the stand-ins become reachable, the home process's next retry records `verified`. |
| `c18-offline-install-continues` | `install`, home process, desktop updater | An install or update attempted while the log is unreachable or its newest witnessed checkpoint is stale prints the reason and the warning, installs, and records `unchecked` with the reason. |
| `c18-missing-cosignature-install-continues` | `install`, home process, desktop updater | An install or update whose latest checkpoint carries no cosignature from a listed witness warns, installs, and records `unchecked` with the reason. |
| `c18-invalid-cosignature-refuses-install` | `install`, home process, desktop updater | A cosignature from a listed witness that is present and does not verify installs nothing and records no check state. |
| `c18-contradicting-log-refuses-install` | `install`, home process, desktop updater | An install or update attempted while the log answers with a checkpoint whose signature does not verify, that is smaller than the stored one, or whose consistency proof from the stored or bundle checkpoint does not verify installs nothing, records no check state, and the running version stays. |
| `c18-inconsistent-log-fails-start` | CLI launcher | A latest checkpoint whose consistency proof from the stored checkpoint does not verify records `failed` and stops the start in every verification mode. |
| `c18-checkpoint-rollback-refused` | CLI launcher | A witnessed checkpoint with a smaller tree size than the stored one records `failed`. |
| `c18-desktop-refuses-unlogged-update` | desktop updater | A desktop update whose bundle fails is refused before `quitAndInstall`. |

### What this does not prove

- **Witness independence.** A client verifies that a witness key listed in the root metadata cosigned the checkpoint. It cannot verify that the witness is operated independently of the log or of Delorun; that rests on which witnesses the root metadata lists.
- **An offline home.** A home that never reaches the log stays `unchecked` and keeps starting with the warning. It never completes the consistency check, so a different view of the log shown to it is not detected until it connects. An install or update that cannot reach the log goes on the same way, so whoever can block a person's connection to the log and its witness leaves that person with the release's signature and the offline inclusion proof alone.
- **Clock dependence.** The 24-hour limit on the latest witnessed checkpoint's age uses the client's clock; a wrong clock can accept an older checkpoint or record `unchecked` for a current one.
- **What a log entry means.** A verified entry shows that the manifest was published in a log every client can check; it does not show that the release is free of defects or vulnerabilities.
