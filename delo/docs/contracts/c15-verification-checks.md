---
description: "Contract C15: the verification check registry, the checks and their stages, the result and mode semantics, the report schema, the badge rule and the denial tests."
---

# Contract C15: verification checks and report

English | [中文](c15-verification-checks.zh.md)

<a id="summary"></a>
## Summary

Verification checks report whether a person's own Delo is what the person expects. A check is a registered function that inspects one part of the home and yields one of four results. The checks run in the home's process with the person's access. Their report lists each result with a short detail that never contains a secret or file content, and the badge is green only when the mode is `enforce` and every check passes. The checks detect drift, tampering by other programs and misconfiguration. They do not hold back the person who owns the machine, and the mode decides which results block a start or reach.

<a id="contents"></a>
## Contents

- [Summary](#summary)
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

Each check is one entry in the check registry of `@delo/integrity`. An entry has these fields.

| Field | Type | Rule |
| --- | --- | --- |
| `id` | Lower kebab-case string. | Unique in the registry and never reused. |
| `blocks` | `none`, `start` or `reach`. | Names the only effect the check may have in `enforce` mode. |
| `subject` | String. | Names what the check inspects, in the terms of the contract that defines it. |

<a id="checks-and-stages"></a>
### Checks and stages

The stages are `start`, `update`, `change` and `verify`. `start` runs when the home starts. `update` runs after an update applies. `change` runs after a reach option or the runtime changes. `verify` runs on `delorun verify` and when the studio's Verification panel refreshes. Every registered check runs in every run, and the report names the stage of the run.

The registry contains these checks.

| `id` | `blocks` | Inspects |
| --- | --- | --- |
| `release-signature` | `none` | The installed release's signature and its release-log entry, under the release contract. |
| `runtime-files` | `start` | The runtime files against the signed manifest, under the release contract. A changed file is a `fail`. |
| `workspace-isolation` | `none` | The isolation in effect for each workspace, and the limits that Docker enforces on the machine. |
| `confinement-rule` | `none` | Whether the sandbox dialect of the machine keeps confined commands from reading or connecting to anything under `~/.delo` and the Docker socket, under the runtime contract. A dialect that cannot enforce it is a `not-enforced`. |
| `reach-binding` | `reach` | The reach listener's binding and the active reach option. An exposure mismatch is a `fail`. |
| `own-domain-caa` | `reach` | The CAA record for an own domain, checked only for the parameters that the certificate authority named by the reach contract enforces. |
| `certificates` | `reach` | The certificate state for the home's names, and the certificate alerts that the home has raised. |
| `owner-and-devices` | `none` | The owner, the trusted devices and the identity factor of each reach address. |
| `plugin-pins` | `none` | The plugin pins, the compatibility badges and the revocation list. |
| `data-sharing` | `none` | The two upstream opt-ins, which are on or off as the person set them. |
| `home-modes` | `none` | The mode of `~/.delo` and of its secret files. A mode with group or other bits is a `fail`, and the detail names the `chmod` command that fixes it. |

The launcher's runtime hash check is outside the registry. It stops a changed runtime in every mode, so a modified `@delo/integrity` package does not disable it.

<a id="results"></a>
### Results

A check yields one of four results.

- `pass`: the inspected state matches what the contract requires.
- `fail`: the inspected state differs from the requirement, through drift, tampering or misconfiguration.
- `not-enforced`: the machine cannot enforce the requirement, such as a sandbox dialect that cannot deny connections to a socket.
- `unknown`: the check could not finish, for example because an input it reads is absent or unreadable.

<a id="modes"></a>
### Modes

The mode is `warn`, `enforce` or `off`. The person sets it in settings under the key `integrity.mode`, or with `delorun verify --mode`.

- `warn`, the default: the checks run at their stages and report every result. No result stops a start or reach. The launcher's runtime hash check still stops a changed runtime.
- `enforce`: a `fail` from a check whose `blocks` is `start` stops the start. A `fail` from a check whose `blocks` is `reach` stops reach until the result passes. A `fail` from a check whose `blocks` is `none` has no effect beyond the report and the badge.
- `off`: the checks do not run at `start`, `update` or `change`. `delorun verify` and the Verification panel still run them on request and show the mode as `off`.

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

The home's report carries no signature. A machine report carries a `signature` made with that machine's key over the report's canonical JSON bytes without the `signature` field, and it carries the home's single-use challenge, which is a 32-byte value encoded as base64url.

<a id="badge"></a>
### Badge

The badge is `green` only when the mode is `enforce` and every check in the run yields `pass`. In every other case the badge is `not-green`. The badge never reads `green` while a check fails, while a result is `unknown` or `not-enforced`, or while the mode is `warn` or `off`.

<a id="consumers"></a>
## Consumers

- `delo/packages/integrity/`: the check registry, the checks, the result and mode handling, the report and the badge rule.
- `delo/apps/cli`: `delorun verify` with its `--json` and `--mode` options, and `delorun status`, which shows the mode and the last results.
- The studio's Verification panel and badge.
- `delo/packages/contract-verification-checks/`: the registry entry, result, mode, stage and report types.

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

Denial tests:

| Test name | Behaviour proven |
| --- | --- |
| `modified integrity package still fails the launcher check` | With the `@delo/integrity` package altered, the launcher still stops a changed runtime file. |
| `planted secret never appears in a result or a report` | A canary secret in a checked configuration file appears in no check detail, no report and no `delorun verify --json` output. |
| `group-readable device-key file fails verify with a chmod fix` | A device-key file with group or other bits set fails `home-modes`, and its detail names the `chmod 600` command. |
| `home directory that is not 0700 fails verify with a chmod fix` | A `~/.delo` directory with group or other bits set fails `home-modes`, and its detail names the `chmod 700` command. |
| `dialect that cannot enforce the confinement rule reports not-enforced` | On a fixture dialect that cannot deny the connection, `confinement-rule` yields `not-enforced`, and the badge is `not-green`. |
| `badge is never green with a failing or unknown check` | A run that includes one `fail` or one `unknown` yields `not-green` in `enforce`. |
| `badge is never green outside enforce` | A run in which every check passes yields `not-green` in `warn` and in `off`. |
| `changed runtime file stops start in every mode` | A changed runtime file stops the launcher's start in `warn` and in `enforce`. |
| `enforce stops start on a runtime fail` | In `enforce`, a `fail` from `runtime-files` stops the start. |
| `enforce blocks reach on an exposure mismatch` | In `enforce`, a `fail` from `reach-binding` stops reach until the result passes. |
| `warn blocks nothing` | In `warn`, no `fail` stops a start or reach. |

Acceptance tests:

- `each check fails on a planted fault in a fixture home`.
- `every interface shows the mode with each result`.
- `off mode runs no check at start, update or change`.
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
