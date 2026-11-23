# Agent Note: The release root lists the log-entry keys and logs it trusts

Status: implemented

English | [中文](2026-11-23-delorun-release-log-entry-key-agility.zh.md)

## Problem

Every shipped client accepted one release-log entry type: an Ed25519ph `hashedrekord` entry signed by the targets key, under the one log the root names. On 22 and 23 November 2026 Sigstore's Rekor stopped accepting Ed25519ph entries, so no release could be signed with an inclusion proof, and the only way to accept another entry type was a client release that the stalled log could not let through. A move to a new Rekor shard had the same shape: a root rotation could point `log` at the new shard, but the start check of every release logged in the old shard would then fail.

## Decision

Root metadata ([C2](../../../../delorun/docs/contracts/c02-release-manifest.md#root-metadata)) gains two fields. `logEntryKeys` lists each key trusted to sign release log entries, with its entry key type (`PKIX_ECDSA_P256_SHA_256`, the primary, or `PKIX_ED25519_PH`), its DER public key and a status (`active`, `retired` with `lastRelease`, or `revoked`), as targets keys have. `logs` lists every log whose checkpoints verify a bundle, `log` among them. A release verifies only under a root that carries both (owner ruling A616: Delorun has no users to keep compatible, so no fallback rule remains); they are optional in the schema only so that the root chain can still read `1.root.json`, under which no release verifies and whose releases are not re-signed.

A client ([C18](../../../../delorun/docs/contracts/c18-release-log.md#verifying-a-bundle)) accepts an entry only when its type is listed and implemented, its public key is byte for byte a listed key of that type valid for the release (a `revoked` key for none, a `retired` key up to its `lastRelease` by the signed manifest's version), its digest is the type's digest of the signed file, and its signature verifies with that listed key; a checkpoint of any listed log still needs the listed witnesses' cosignatures. The log accepting an entry proves none of this. The signing tool signs with the root's listed `active` keys in the root's order and moves to the next only when the log refuses the entry's key type with HTTP 400 and one of two exact messages, after its own request verified locally.

The lists change only by a root rotation, which the offline root key signs; the timestamp and targets keys cannot change them. A client keeps the newest root it verified, so a replayed older root cannot bring back a removed key type. Security fundamental F25 states the rule.

The production allowance for a locally built 0.x release (A506) pins one root file by its SHA-256: `2.root.json` once the rotation that adds these fields is signed, and the launcher ships that root alone, so it never verifies anything under `1.root.json`.

## Verification

The denial specs `c18-root-without-log-trust-refused`, `c18-listed-entries-only`, `c18-unlisted-entry-type-refused`, `c18-listed-type-other-key-refused`, `c18-revoked-entry-key-refused`, `c18-retired-entry-key-by-signed-version`, `c18-unlisted-log-origin-refused` and `c18-listed-log-needs-witness` in `delorun/packages/release-verify/tests/entry-keys.spec.ts`, `c02-log-entry-keys-unverified-root-refused`, `c02-replayed-root-cannot-restore-type` and `local-builder-pins-root-digest` in `delorun/apps/install/tests/key-agility.integration.spec.ts`, and `log-fallback-only-on-type-refusal` and `log-fallback-verifies-success` in `delorun/apps/release/tests/log/fallback.integration.spec.ts` each fail when the check they name is removed.

## Related

The [extension-point-first decision](2026-11-06-delorun-extension-point-first.md) does not apply: the release root is Delorun's own format.

## Alternatives considered

**A DSSE entry signed with pure Ed25519.** It changes the entry kind every shipped client verifies and leaves a single entry type, so the next refusal stalls releases again.

**A second key without a list in the root.** A client release would name the key, and every later change of key type or log would need another client release.

**Keeping the Ed25519ph-by-targets rule for a root without the list.** It kept copies on 0.1.0-preview.2.7 updating without a reinstall, at the cost of a second verification path; with no users to keep (A616) the path was removed.

**A production allowance for every later root that keeps the preview targets key.** It needs no code change after the rotation, but walks the chain from `1.root.json` and adds a rule; pinning `2.root.json`'s digest is one comparison, and the Trust page publishes that digest anyway.

## Consequences

A log that stops accepting a key type, or a new log shard, is a root rotation and a switch in the signing tool, never a client release. A client released before these fields refuses a root that carries them by its strict schema, so copies on 0.1.0-preview.2.7 or earlier need one reinstall through npm. A release logged in an earlier listed log is verified offline at each start and stays `unchecked` online, because the online check reads only the current log. `PREVIEW_ROOT_SHA256` names `1.root.json` until the rotation's change sets it to `2.root.json`'s digest; until then a production launcher installs no locally built release.
