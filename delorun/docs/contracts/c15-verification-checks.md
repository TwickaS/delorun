---
description: "Contract C15: the verification check registry, the checks and their stages, the result and mode semantics, the report schema, the badge rule and the denial tests."
---

# Contract C15: verification checks and report

English | [中文](c15-verification-checks.zh.md)

<a id="summary"></a>
## Summary

Verification checks report whether a person's own Delorun is what the person expects. A check is a registered function that inspects one part of the home and yields one of four results. The checks run in the home's process with the person's access. Their report lists each result with a short detail that never contains a secret or file content, and the badge is green only when the mode is `enforce` and every check passes. The checks detect drift, tampering by other programs and misconfiguration. They do not hold back the person who owns the machine, and the mode decides which results block a start or reach.

<a id="status"></a>
## Status

Two of the eleven checks run, only on `delorun verify`, and only in `warn`; the other checks, the stages, the selectable modes and the Verification panel are not built.

- **Built and reached:** `delorun verify` with `--release`, `--offline` and `--json` runs `release-signature` (the stored root anchored on the roots the launcher ships, the manifest's signature, the timestamp's freshness and the release-log bundle, with the online check unless `--offline`) and `runtime-files` (every installed file against the signed file list), and reports every other registry entry as `unknown` with the detail "delorun verify does not include this check", which the text report leaves out and counts instead. Its report carries the notice, a detail of at most 512 characters, the mode `warn` and the badge `not-green`. After the check lines it prints a bill of materials of the Delorun, which `--json` carries as `bill` (`delorun.trust-bill/1`): the release's commit, manifest and file-list SHA-256 values, trusted root, launcher and last full hash; the launcher's start check; the recorded release-log state; the profile's plugins; Changes; the rows and `!!js` values of the person's patch layers; the skill roots; and the MCP servers. Plugins and Changes are `unknown` until the plugin install check and Changes provide them. The text report states that the checks run with the person's access and that a program running with that access can change them, and its summary names the bill's state. The launcher's start check of the runtime files and the release log runs at every start, outside the registry. In a running Host the `delorun-trust` row runs the same `delorun verify --json` through the launcher by itself once the studio has started and no turn has run for its idle wait, at low priority, stops it when a turn starts and runs it again after the next idle stretch; only a pass of that check, or a start check that hashed every file, makes the release verified, and a check run inside the Host is never verified.
- **Not built:** the checks `workspace-isolation`, `confinement-rule`, `reach-binding`, `own-domain-caa`, `certificates`, `owner-and-devices`, `plugin-pins`, `data-sharing` and `home-modes`; runs at the `start`, `update` and `change` stages; the `integrity.mode` setting and `delorun verify --mode`, so `enforce` and `off` cannot be selected and the badge is never `green`; the `@delorun/integrity` package; the studio's Verification panel; `delorun status` showing the mode and the last results; the signed machine report.

The requirements and denial tests below that this list names as not built or reached by nothing protect no one until a change builds and wires them.

<a id="contents"></a>
## Contents

- [Summary](#summary)
- [Status](#status)
- [Contract](#contract)
  - [Registry entry](#registry-entry)
  - [Checks and stages](#checks-and-stages)
  - [Results](#results)
  - [Modes](#modes)
  - [Report](#report)
  - [Badge](#badge)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)
- [Decided values](#decided-values)

<a id="contract"></a>
## Contract

<a id="registry-entry"></a>
### Registry entry

Each check is one entry in the check registry, `VERIFICATION_CHECKS` of `@delorun/contract-verification-checks`. An entry has these fields.

| Field | Type | Rule |
| --- | --- | --- |
| `id` | Lower kebab-case string. | Unique in the registry and never reused. |
| `blocks` | `none`, `start`, `reach` or `start-always`. | Names the only effect the check may have in `enforce` mode, except that `start-always` applies in every mode. |
| `subject` | String. | Names what the check inspects, in the terms of the contract that defines it. |

<a id="checks-and-stages"></a>
### Checks and stages

The stages are `start`, `update`, `change` and `verify`. `start` runs when the home starts. `update` runs after an update applies. `change` runs after a reach option or the runtime changes. `verify` runs on `delorun verify` and when the studio's Verification panel refreshes. Every registered check runs in every run, and the report names the stage of the run. Only the `verify` stage runs, through `delorun verify`, and it runs `release-signature` and `runtime-files`; every other entry yields `unknown` with the detail "delorun verify does not run this check".

The registry contains these checks.

| `id` | `blocks` | Inspects |
| --- | --- | --- |
| `release-signature` | `start-always` | The installed release's signature and its release-log entry, under the release contract. A verified failure stops the start in every mode. |
| `runtime-files` | `start` | The runtime files against the signed manifest, under the release contract. A changed file is a `fail`. |
| `workspace-isolation` | `none` | The isolation in effect for each workspace, and the limits that Docker enforces on the machine. |
| `confinement-rule` | `none` | Whether the sandbox dialect of the machine keeps confined commands from reading Delorun's secrets or tokens, and from connecting to its control sockets and the Docker socket, under the runtime contract. A dialect that cannot enforce it is a `not-enforced`. |
| `reach-binding` | `reach` | The reach listener's binding and the active reach option. An exposure mismatch is a `fail`. |
| `own-domain-caa` | `reach` | The CAA record for an own domain, checked only for the parameters that the certificate authority named by the reach contract enforces. |
| `certificates` | `reach` | The certificate state for the home's names, and the certificate alerts that the home has raised. |
| `owner-and-devices` | `none` | The owner, the trusted devices and the identity factor of each reach address. |
| `plugin-pins` | `none` | The plugin pins, the compatibility badges and the revocation list. |
| `data-sharing` | `none` | The two upstream opt-ins, which are on or off as the person set them. |
| `home-modes` | `none` | The mode of `~/.delorun` and of its secret files. A mode with group or other bits is a `fail`, and the detail names the `chmod` command that fixes it. |

The launcher's runtime start check is outside the registry: the npm launcher calls `@delorun/runtime-store` at every start, and a changed, missing or extra runtime file stops the start in every mode, so a change to the registry or to `delorun verify` does not disable it. A start hashes the files its identity record cannot vouch for ([C2](c02-release-manifest.md#client-verification)); `runtime-files` under `delorun verify` always hashes every file.

Each confinement rule state maps to a verification check result: `enforced` is `pass`, `not-enforced` is `not-enforced`, `unconfined` is `fail` and `unknown` is `unknown`. The `confinement-rule` check applies that mapping to each rule of [C1](c01-home-layout.md#confinement-rules).

<a id="results"></a>
### Results

A check yields one of four results.

- `pass`: the inspected state matches what the contract requires.
- `fail`: the inspected state differs from the requirement, through drift, tampering or misconfiguration.
- `not-enforced`: the machine cannot enforce the requirement, such as a sandbox dialect that cannot deny connections to a socket.
- `unknown`: the check could not finish, for example because an input it reads is absent or unreadable.

<a id="modes"></a>
### Modes

The mode is `warn`, `enforce` or `off`. The contract sets it in settings under the key `integrity.mode`, or with `delorun verify --mode`. Neither exists: nothing reads `integrity.mode`, `delorun verify` has no `--mode` option and always reports in `warn`, and the launcher always applies its start rules as `enforce` does, so a person cannot select `enforce` or `off`.

- `warn`, the default: the checks run at their stages and report every result. No result stops a start or reach, except a `start-always` `fail`. The launcher's runtime hash check still stops a changed runtime.
- `enforce`: a `fail` from a check whose `blocks` is `start` stops the start. A `fail` from a check whose `blocks` is `reach` stops reach until the result passes. A `fail` from a check whose `blocks` is `none` has no effect beyond the report and the badge.
- `start-always`, used only by `release-signature`: a `fail` stops the start in every mode, including `warn` and `off`. Such a `fail` is a verified release-signature or release-log failure, the `failed` state of [C18](c18-release-log.md). An `unknown` result never blocks.
- `off`: the checks do not run at `start`, `update` or `change`, except that `release-signature` runs its offline verification at `start` in every mode. `integrity.mode: off` also stops the automatic online release-log check ([C18](c18-release-log.md)) and the revocation-list fetch ([C13](c13-catalogue-revocation.md)). `delorun verify` and the Verification panel still run the checks on request and show the mode as `off`.

Every interface that shows a result shows the mode with it. A `not-enforced` and an `unknown` result never block anything, in any mode.

<a id="report"></a>
### Report

A report is a JSON object with these fields.

```json
{
  "schemaVersion": 1,
  "mode": "warn",
  "stage": "verify",
  "generatedAt": "<RFC 3339 UTC time>",
  "notice": "checks run with the person's access",
  "badge": "not-green",
  "checks": [
    { "id": "runtime-files", "result": "pass", "detail": "" }
  ]
}
```

| Field | Type and values | Rule |
| --- | --- | --- |
| `schemaVersion` | Integer `1`. | Readers refuse any other value. |
| `mode` | `warn`, `enforce` or `off`. | The mode in effect when the run started. |
| `stage` | `start`, `update`, `change` or `verify`. | The stage of the run. |
| `generatedAt` | RFC 3339 time in UTC. | The time the run finished. |
| `notice` | The string `checks run with the person's access`. | Present in every report. |
| `badge` | `green` or `not-green`. | Follows the badge rule below. |
| `checks` | One object for each registry entry. | Each object has `id`, `result` and `detail`. |
| `checks[].detail` | String of at most 512 characters. | Names the state and the fix. It never contains a secret, a token, an owner code, a cookie, a key or file content. |

`delorun verify` also prints, after its check lines, the changes the person approved and anything present they did not approve, and its `--json` report adds them as `changes` ([C21](c21-changes.md#what-verify-and-doctor-report)).

The home's report carries no signature. A machine report carries a `signature` made with that machine's key over the report's canonical JSON bytes without the `signature` field, and it carries the home's single-use challenge, which is a 32-byte value encoded as base64url.

<a id="badge"></a>
### Badge

The badge is `green` only when the mode is `enforce` and every check in the run yields `pass`. In every other case the badge is `not-green`. The badge never reads `green` while a check fails, while a result is `unknown` or `not-enforced`, or while the mode is `warn` or `off`.

<a id="consumers"></a>
## Consumers

- `delorun/apps/cli`: `delorun verify` with its `--release`, `--offline` and `--json` options, which runs the two built checks, the report, the badge rule and the bill of materials (`startBill` and `runVerifyStage` in `src/verify/bill.ts`). `delorun status` shows no verification result.
- `delorun/apps/npm-launcher` and `delorun/packages/runtime-store`: the launcher's start check, outside the registry.
- The `@delorun/integrity` package, the studio's Verification panel and badge, and `delorun verify --mode` are not built.
- `delorun/packages/contract-verification-checks/`: the registry entry, result, mode, stage and report types.

<a id="compatibility"></a>
## Compatibility

The registry is additive. A new check adds one entry with its stages, its `blocks` value and its planted-fault test in the same change. A check id is never reused, and a removed check is retired by keeping its id unassigned.

A change to the report's fields that a reader cannot ignore increments `schemaVersion`. Adding an optional field does not.

The `blocks` value of a check is part of its contract. Changing it from `none` to `start` or `reach` is a change to what a person's start or reach depends on, and it is shown in the release notes.

<a id="security"></a>
## Security

Requirements:

- A result, a detail or a report never contains a secret, a token, an owner code, a cookie, a key or file content.
- Every report states that the checks run with the person's access, and that a program running with that access can change the checks.
- The badge is green only in `enforce` with every check passing.
- The launcher's runtime hash check and the registry are separate, so a modified integrity package still fails the launcher's check.
- A `not-enforced` or an `unknown` result never counts as a pass.
- A verified release-signature or release-log failure stops the start in every mode; an `unknown` or `not-enforced` result never does.

Denial tests:

| Test name | Behaviour proven |
| --- | --- |
| `modified integrity package still fails the launcher check` | With the `@delorun/integrity` package altered, the launcher still stops a changed runtime file. |
| `planted secret never appears in a result or a report` | A canary secret in a checked configuration file appears in no check detail, no report and no `delorun verify --json` output. |
| `group-readable device-key file fails verify with a chmod fix` | A device-key file with group or other bits set fails `home-modes`, and its detail names the `chmod 600` command. |
| `home directory that is not 0700 fails verify with a chmod fix` | A `~/.delorun` directory with group or other bits set fails `home-modes`, and its detail names the `chmod 700` command. |
| `dialect that cannot enforce the confinement rule reports not-enforced` | On a fixture dialect that cannot deny the connection, `confinement-rule` yields `not-enforced`, and the badge is `not-green`. |
| `badge is never green with a failing or unknown check` | A run that includes one `fail` or one `unknown` yields `not-green` in `enforce`. |
| `badge is never green outside enforce` | A run in which every check passes yields `not-green` in `warn` and in `off`. |
| `changed runtime file stops start in every mode` | A changed runtime file stops the launcher's start in `warn` and in `enforce`. |
| `enforce stops start on a runtime fail` | In `enforce`, a `fail` from `runtime-files` stops the start. |
| `enforce blocks reach on an exposure mismatch` | In `enforce`, a `fail` from `reach-binding` stops reach until the result passes. |
| `warn blocks nothing except a start-always fail` | In `warn`, no `fail` stops a start or reach, except a `fail` from `release-signature`. |
| `verified release failure stops start in every mode` | A `fail` from `release-signature` stops the start in `warn`, `enforce` and `off`, and an `unknown` from an offline check does not. |
| `off stops online checks and keeps the offline release check` | With `integrity.mode: off`, the launcher sends no online release-log request and the Host sends no revocation-list request at start, and the stored bundle's offline verification still runs at start. |

Acceptance tests:

- `each check fails on a planted fault in a fixture home`.
- `every interface shows the mode with each result`.
- `off mode runs no online check at start, update or change; the offline release check still runs at start`.
- `verify --json output states the notice and the mode`.

<a id="decided-values"></a>
## Decided values

- The default mode is `warn`.
- The setting key is `integrity.mode`.
- The stages are `start`, `update`, `change` and `verify`.
- The results are `pass`, `fail`, `not-enforced` and `unknown`.
- The report schema version is `1`, and a detail is at most 512 characters.
- The notice text is `checks run with the person's access`.
- A machine report signs with Ed25519 over canonical JSON and carries a 32-byte base64url challenge.
