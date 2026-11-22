---
description: "Contract C13: the signed catalogue index Discover lists first, its entry schema, the 'tested with Delorun X' badge record, findings an entry may list as their author's or a reviewer's claims, the signed revocation list with sequence numbers, expiry and a 24-hour maximum cache age, the stale state, disabling a revoked plugin at its next load, and where both files are served."
---

# C13 Catalogue index and revocation list

English | [中文](c13-catalogue-revocation.zh.md)

## Summary

The catalogue is a public index of plugins in the repository `TwickaS/delo-plugins`, where adding a plugin is a pull request. Its publish job signs two files with the catalogue key of [C2](c02-release-manifest.md#key-roles), the index and the revocation list, and GitHub Pages serves them at `catalogue.delorun.com`; the host is not trusted, because a client refuses a file whose signature does not verify. An index entry pins exact plugin versions with their integrity hashes, carries "tested with Delorun X" badges from the compatibility corpus, and may list findings, which the studio shows as the claims of the plugin's author or a named reviewer: Delorun runs no plugin audit and does not verify them. The revocation list names plugin versions Delorun disables at their next load, with sequence numbers against replay, an expiry and a maximum cache age of 24 hours; past that age the studio enters a stale state. The types live in [`@delorun/contract-catalogue-revocation`](../../packages/contract-catalogue-revocation/README.md).

## Status

Nothing on this page is built: no code fetches, verifies or caches a catalogue index or a revocation list.

- **Built and reached:** the `catalogue` key role in the root metadata schema of [C2](c02-release-manifest.md#key-roles), and the file name `catalogue/revocations.json` in the home layout of [C1](c01-home-layout.md). Plugins install through upstream's plugin manager, which records each package's integrity hash in the profile's `pnpm-lock.yaml`; Delorun adds no pin of its own.
- **Not built:** the `@delorun/catalogue` package; the signed index and revocation list and their publish job; installing from the catalogue with exact versions and integrity pins; the sequence, expiry and 24-hour cache-age checks; the stale state; disabling a revoked plugin version at its next load; badges and listed findings in the studio; the `plugin-pins` check, which `delorun verify` reports as not run. `delorun update`'s report lists `revocations` as not checked.

The requirements and denial tests below that this list names as not built or reached by nothing protect no one until a change builds and wires them. A plugin installed stays enabled whatever is later known about it, until the person removes it.

## Contents

- [Status](#status)
- [Where the files are served](#where-the-files-are-served)
- [Catalogue index](#catalogue-index)
- [Badge record](#badge-record)
- [Listed findings](#listed-findings)
- [Installing from the catalogue](#installing-from-the-catalogue)
- [Revocation list](#revocation-list)
- [Fetching and caching](#fetching-and-caching)
- [Stale state](#stale-state)
- [Disabling a revoked plugin](#disabling-a-revoked-plugin)
- [Catalogue repository CI](#catalogue-repository-ci)
- [Values and limits](#values-and-limits)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)

## Where the files are served

| URL | File |
| --- | --- |
| `https://catalogue.delorun.com/index.json` | The catalogue index in the signature envelope of [C2](c02-release-manifest.md#signature-envelope). |
| `https://catalogue.delorun.com/revocations.json` | The revocation list in the same envelope. |

Both verify with the `catalogue` role of the client's trusted root ([C2](c02-release-manifest.md#root-metadata)). GitHub Pages, DNS or a network path can withhold or delay these files, which the expiry and the stale state bound; they cannot change or replay them undetected. The requests carry no identifier of the person; they reveal the IP address and the client version to the host. The person can turn off catalogue fetching; then Discover lists no catalogue entries, and the studio says that revoked versions are not disabled while it is off.

## Catalogue index

`index.json`, schema `delorun.catalogue-index/1`:

| Field | Type | Meaning |
| --- | --- | --- |
| `sequence` | integer ≥ 1 | Adds 1 at every signing. |
| `issued`, `expires` | timestamp | `expires` is exactly 7 days after `issued`; the publish job re-signs every 24 hours and on every merge. |
| `entries` | list of entry | One per plugin package, sorted by `package`. |

Entry:

| Field | Type | Meaning |
| --- | --- | --- |
| `package` | npm package name | The plugin's package; unique in the index. |
| `title`, `description` | string | Sentence-case display text from the plugin's `meta`, at most 80 and 300 characters. |
| `repository` | HTTPS URL | The plugin's source repository. |
| `license` | SPDX expression | As the package declares it. |
| `author` | `{ "name", "github" }` | The plugin's author and their GitHub login. |
| `addedBy` | integer | The number of the pull request that added the entry. |
| `versions` | list of version | Newest first; at least 1. |

Version:

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | exact semantic version | One published version. |
| `integrity` | `sha512-` string | The npm tarball's integrity; installs pin it. |
| `engines` | `{ "dsh"?, "delorun"? }` | The ranges the package declares, copied from its manifest ([C17](c17-plugin-versions.md)). |
| `badges` | list of badge record | Corpus results for this version. |
| `findings` | list of finding | Findings listed for this version; may be empty. |

## Badge record

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `tested-with-delorun` | The only badge kind. |
| `delorun`, `dsh` | exact semantic version | The Delorun release and its upstream version the corpus ran. |
| `channel` | `stable` or `beta` | The channel of that Delorun release. |
| `result` | `passed` or `failed` | The corpus result. |
| `corpus` | 40-hex commit | The corpus revision that ran. |
| `run` | HTTPS URL | The CI run that produced the result. |
| `recorded` | timestamp | When the publish job recorded it. |

The studio shows a badge only for `passed`, and only as "Tested with Delorun <delorun>", the release named. A badge says the plugin version passed the compatibility corpus on that release; it is not an endorsement or a security review, and no screen words it otherwise.

## Listed findings

A version may list findings. Each is a claim by its author, which Delorun does not verify.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique within the entry, at most 64 characters of `[a-z0-9-]`. |
| `severity` | `info`, `low`, `medium`, `high` or `critical` | As the finding's author rates it. |
| `title` | string | At most 120 characters. |
| `detail` | string | Plain text, at most 4,000 characters; the studio renders it as text, never as HTML or Markdown links. |
| `author` | `{ "role", "name", "github" }` | `role` is `plugin-author` or `reviewer`; a reviewer is named by name and GitHub login. |
| `reported` | date | When the finding was listed. |
| `fixedIn` | exact semantic version, optional | A later version its author says fixes it. |

Display rules:

- Every finding renders with its author's role and name and the label "Claim by <name>, not verified by Delorun".
- No screen says "audited", "safe" or "no findings" about a plugin, or calls a plugin verified. A version with no listed findings renders "The catalogue lists no claims about this version. Delorun does not audit plugins." With no `pluginAudit` service mounted, the install screen says that findings from an audit are unavailable.
- A finding's digest is the SHA-256 of the RFC 8785 canonical JSON of the finding. Accepting the findings of a version before installing records their digests in the plugin manager's acceptance ledger (mode 0600, digests only). A missing ledger, or one that is not that record, reads as no acceptance, so the findings ask again; a changed finding has a new digest and asks again.

## Installing from the catalogue

- Discover lists the catalogue's entries first, through upstream's plugin market, then the other sources it already lists.
- An install pins the exact version and its `integrity`; a tarball whose integrity differs from the index is refused.
- An install of a version the current revocation list revokes is refused with the list's reason.
- An install is refused while the revocation list is stale ([stale state](#stale-state)).
- Both version axes are checked before installing ([C17](c17-plugin-versions.md)).
- An index that fails verification, is older than the stored `sequence`, or has expired is not used; Discover shows the catalogue as unavailable with the reason and lists no catalogue entries.

## Revocation list

`revocations.json`, schema `delorun.catalogue-revocations/1`:

| Field | Type | Meaning |
| --- | --- | --- |
| `sequence` | integer ≥ 1 | Adds 1 at every signing. |
| `issued`, `expires` | timestamp | `expires` is exactly 48 hours after `issued`; the publish job re-signs every 24 hours and on every change. |
| `revocations` | list of revocation | Sorted by `package`, then `revoked`. |

Revocation:

| Field | Type | Meaning |
| --- | --- | --- |
| `package` | npm package name | The plugin package; it applies however the plugin was installed. |
| `versions` | list of exact semantic versions | The revoked versions, at least 1. |
| `reason` | `malicious`, `vulnerable`, `broken` or `author-request` | The reason code. |
| `message` | string | English text shown with the reason, at most 500 characters. |
| `advisory` | HTTPS URL, optional | A public advisory about it. |
| `revoked` | timestamp | When it was added. |

A list with any malformed revocation is refused as a whole; the client keeps the last list it verified.

## Fetching and caching

- The Host fetches the revocation list at every start and every 6 hours while it runs, and the index when Discover opens and every 24 hours.
- Under `integrity.mode: off` ([C15](c15-verification-checks.md#modes)) the Host fetches no revocation list, so the list becomes stale under the rule below.
- The client stores the newest verified list and its `sequence` and fetch time at the path [C1](c01-home-layout.md) names.
- A list with a lower `sequence` than the stored one is refused; an equal `sequence` must have identical bytes.
- The list's cache age is the time since the client last fetched and verified a list. The maximum cache age is 24 hours.

## Stale state

The revocation list is stale when the cache age exceeds 24 hours, when the stored list is past `expires`, or when no list has verified. While it is stale:

- the studio shows "The plugin revocation list has been out of date since <time>; new catalogue installs are paused." with the reason of the last failure;
- new catalogue installs and catalogue updates are refused;
- installed plugins keep loading, and versions the last verified list revoked stay disabled;
- the Host retries every 15 minutes, and the stale state ends at the first verified list.

Installing a plugin from a file or directly from npm does not use the catalogue, so the stale state does not affect it.

`delorun verify` reports the stale state ([C15](c15-verification-checks.md)).

## Disabling a revoked plugin

- When a newly verified list revokes an installed version, the running plugin is not stopped. The studio shows the plugin, the reason and the message, and a prompt to restart.
- At the next load, the profile's row for that version is disabled before the Loader imports it, and the change is a profile history version naming the revocation ([C3](c03-update-report.md)).
- The plugin's screen offers updating to a version the list does not revoke and keeping it disabled. Re-enabling a revoked version needs the person's confirmation on a screen naming the reason, and the acceptance ledger records it for that exact `package@version` and the list's `sequence`; a later list that revokes it again for a new reason asks again.

## Catalogue repository CI

- The corpus job runs plugin code against the current stable and beta Delorun releases. It holds no token that can write the index, badges or the repository, and never runs pull-request code under `pull_request_target`.
- A separate publish job, which runs no plugin code, reads the corpus results as an artifact, validates them, writes badge records and signs both files with the catalogue key.
- A pull request that changes an entry fails when the entry does not validate against this schema.

## Values and limits

| Value | Number |
| --- | --- |
| Revocation list maximum cache age | 24 hours |
| Revocation list expiry | 48 hours after `issued`, re-signed every 24 hours |
| Revocation list refresh while running | every 6 hours |
| Retry interval while stale | 15 minutes |
| Index expiry | 7 days after `issued`, re-signed every 24 hours |
| Index size limit before parsing | 16 MiB |
| Revocation list size limit before parsing | 1 MiB |
| Findings per version | at most 50 |
| Text limits | title 80, description 300, finding title 120, finding detail 4,000, revocation message 500 characters |
| Request timeout | 30 seconds |

## Consumers

- `TwickaS/delo-plugins`: the index, its schema check, the corpus and the publish job.
- `delorun/packages/catalogue/src/revocation/`: fetching, the stale state and disabling at load.
- Discover's configuration and studio plugin: listing, badges, findings and installs.
- `delorun verify` ([C15](c15-verification-checks.md)) and the update report ([C3](c03-update-report.md)).

## Compatibility

Each file's `schema` names its major version, and readers refuse unknown fields, so any new field is a new major version, published beside the old one while clients that read only the old one are supported. The catalogue role's key rotates only through a root version ([C2](c02-release-manifest.md#key-rotation)). Upstream's plugin market and its other sources stay as upstream ships them; the catalogue is one more source listed first.

## Security

### Requirements

- R1. Both files are signed with the catalogue key and served from a host that is not trusted; a file that does not verify is not used.
- R2. The revocation list carries a `sequence`, an expiry 48 hours after issue and a maximum cache age of 24 hours; a lower `sequence` is refused.
- R3. A stale list refuses new catalogue installs, keeps installed plugins loading with already revoked versions disabled, says so in the studio and retries.
- R4. A malformed revocation refuses the whole list; security rows fail closed.
- R5. A revoked version is disabled at its next load with its reason, a history version and a restart prompt.
- R6. Badges read only "Tested with Delorun X" with the release named, and only the publish job, which runs no plugin code, writes them.
- R7. No screen claims that Delorun audits plugins; findings render labelled with their author as claims Delorun does not verify, and the acceptance ledger fails closed.
- R8. The corpus job holds no write token, and no catalogue workflow uses `pull_request_target`.

### Denial tests

| Test | Component | Behaviour it shows |
| --- | --- | --- |
| `c13-replayed-list-refused` | `catalogue` | A validly signed revocation list with a lower `sequence` than the stored one is refused, and the stored list stays. |
| `c13-foreign-key-list-refused` | `catalogue` | A list signed by a key outside the catalogue role is refused. |
| `c13-malformed-revocation-refuses-list` | `catalogue` | A validly signed list with one malformed revocation is refused as a whole. |
| `c13-stale-after-24-hours` | `catalogue` | With the stand-in unreachable and the last fetch 24 hours and 1 second ago, the studio shows the stale notice, a catalogue install is refused, an installed plugin loads, and a version the last list revoked stays disabled. |
| `c13-expired-list-is-stale` | `catalogue` | A list past its `expires` enters the stale state even when fetched within 24 hours. |
| `c13-revoked-disabled-at-next-load` | `catalogue` | A newly revoked installed version keeps running until restart, the restart prompt shows its reason, and after restart its row is disabled with a history version. |
| `c13-revoked-install-refused` | Discover | Installing a revoked version is refused with the list's reason. |
| `c13-integrity-mismatch-refused` | Discover | A tarball whose integrity differs from the index entry is refused. |
| `c13-plugin-cannot-write-badge` | `delo-plugins` | A fixture plugin in the corpus job that tries to write a badge or push fails for lack of a token, and its attempt leaves no badge record. |
| `c13-no-pull-request-target` | `delo-plugins` | A workflow lint fails on any catalogue workflow that uses `pull_request_target`. |
| `c13-no-audited-wording` | Discover | Installing a fixture plugin renders no "audited", "safe" or "no findings" wording and does not call the plugin verified, and says that Delorun does not audit plugins. |
| `c13-findings-labelled-as-claims` | Discover | A fixture entry's findings render with their author's role and name and the "not verified by Delorun" label. |
| `c13-missing-ledger-asks-again` | Discover | With the acceptance ledger missing or malformed, the findings ask again before install. |

### What this does not prove

- **Revocation takes effect at the next load.** A newly revoked version keeps running until the Host loads it again; the list cannot stop plugin code that is already running. Between a revocation and its effect lie up to 6 hours until the next refresh, plus the time until the person restarts.
- **Badge writes.** That only the publish job writes badges is enforced by the CI configuration of `TwickaS/delo-plugins`: the corpus job holds no write token, a separate job publishes, and a workflow lint refuses `pull_request_target`. A client verifies only the catalogue key's signature, so a compromised publish job or catalogue key could sign any badge; the denial tests for badge writes run in that repository, not in this one.
- **Listed findings.** Delorun does not verify listed findings. A finding states what its author claims, and the absence of findings says nothing about a plugin.
- **Clock dependence.** The maximum cache age, the list's expiry and the index's expiry use the client's clock; a clock set back can keep a list in use past its real expiry.
