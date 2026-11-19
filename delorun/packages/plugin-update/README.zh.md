---
description: "The @delorun/plugin-update package, for maintainers of delorun: the studio's update routes under /delorun/update/ (check now, prepare and apply an update with C3's report, cancel, go back, dismiss the outcome, stop Delorun), who may use each from where, what the Host keeps in memory, and how every step reaches the home process over its update channel."
---

# @delorun/plugin-update

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## Summary

This package is the Host half of the studio's update ([update and rollback](../../docs/design/update-and-rollback.zh.md#the-studios-update), [contract C19](../../docs/contracts/c19-home-process.zh.md)). It registers the routes under `/delorun/update/`, decides each request with the Changes gate before its body is read, and asks the home process, over the update channel the Host received at boot, to check, prepare, apply, cancel, roll back and stop. The home process verifies, installs, switches and rolls back; this package only asks and reports.

## Contents

- [Routes](#routes)
- [Who may use each control](#who-may-use-each-control)
- [What the Host keeps](#what-the-host-keeps)
- [Configuration](#configuration)
- [Tests](#tests)

## Routes

`state` is a `GET` that any admitted session reads; every other route is a `POST`.

| Route | Does |
| --- | --- |
| `state` | The release this Host runs, every control's decision for this request, the check, the progress, the prepared report, the outcome record and whether Go back is offered. |
| `check` | Runs the release check now. |
| `prepare` | Asks the home process to fetch, verify and install the newest release and returns C3's report under an opaque handle. |
| `apply` | Begins the update of the prepared report. The body names the handle, `wait` or `stop` for running chats, the data copy choice and the tick keys the person accepted. |
| `cancel` | Ends an update or a rollback that still waits for chats. |
| `rollback` | Goes back from the committed update, `profileOnly` when no copy of the chat data exists. |
| `dismiss` | Removes the outcome record. |
| `stop` | Stops Delorun. Nothing in the studio starts it again. |

The wire types are [`src/wire.ts`](src/wire.ts). `apply`, `rollback` and `stop` answer before the Host stops, as Restart does; the page polls `state` and reloads once when the Host's release differs from the one it loaded.

## Who may use each control

The controls are entries of the Changes access table ([`@delorun/plugin-changes`](../plugin-changes/README.zh.md)), and the routes are built with its gate, so the site fence, the control's class and the device's grant are decided before a body is read.

| Control | Computer | Phone |
| --- | --- | --- |
| `update-check`, `update-cancel`, `update-dismiss` | yes | yes, no prompt (class `free`) |
| `update-begin`, `update-rollback`, `stop` | yes | yes, with a one-action grant for the request (class `face`) |

A grant is a Face ID confirmation or the device's PIN for that one request; the approval grace does not count. `state` shows the prepared report, which names plugins and harness diffs, only to a request that may begin an update.

## What the Host keeps

The report and the home process's report id stay in Host memory; the page holds a random handle, compared in constant time, and the report expires after 600 seconds. The channel token stays inside the `updateChannel` service that `delorun start` provides. The service is a root Cordis service, so any plugin running in the Host can read it and send update, rollback and stop requests without the access table; Cordis offers no way to give one plugin a service name that another cannot read, and plugins in the Host are trusted code, as `changesRestart` is. A second `apply` while one starts is refused with `UPDATE_IN_PROGRESS`. `apply` needs every tick key the report asks for, from the rule `delorun update --yes` uses (`confirmationNeeds` in `@delorun/update`), and refuses a conflicted harness file or a failed release-log check whatever the page sends.

## Configuration

- `waitSeconds`: how long an update or rollback waits for running chats, from 60 to 86,400 seconds, 1,800 by default.
- `checkGapSeconds`: the shortest time between two release checks that reach the network, from 1 to 3,600 seconds, 10 by default. A request while one check runs joins it; a request inside the gap gets the last answer.

## Tests

`tests/update-routes.spec.ts` holds the denial specs: other site, phone without a grant or with only the approval grace, a page-supplied or expired report, a restart or update in progress, missing ticks, a conflicted report, and the channel token and report id never reaching an answer.
