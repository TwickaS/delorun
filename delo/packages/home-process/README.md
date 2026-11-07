---
description: "The @delo/home-process package, for maintainers of delorun and the runtime store: the home process of each CLI profile with its start sequence, the update channel under ~/.delo and its per-start token, the update handshake that never switches the runtime under a running chat, the handover to a new runtime, interrupted updates, the supervisor launch and its operational log."
---

# @delo/home-process

English | [中文](README.zh.md)

## Summary

This package is the home process of [contract C19](../../docs/contracts/c19-home-process.md): one process per CLI profile that holds the profile's home lock under `~/.delo`, writes a new start token at each start, serves the update channel on `run/<profile>/update.sock`, launches the Docker supervisor ([C9](../../docs/contracts/c09-runtime-supervisor.md)) and runs the profile's Host in the same process. An update reaches it only through the update channel and moves the profile to a new runtime only after no chat runs on the old one, so `current` never switches under a running chat. It logs to [C20](../../docs/contracts/c20-operational-logs.md)'s `home-<profile>` surface through [`@delo/logs`](../logs/README.md). The protocol's types and limits come from [`@delo/contract-home-process`](../contract-home-process/README.md); the lock, the token and the channel's listener come from [`@delo/home`](../home/README.md). `delorun start`, `stop` and `status` ([`delo/apps/cli`](../../apps/cli/README.md)) drive it.

## Contents

- [Starting a home process](#starting-a-home-process)
- [The update channel](#the-update-channel)
- [The update handshake](#the-update-handshake)
- [The handover](#the-handover)
- [Interrupted updates](#interrupted-updates)
- [Stopping](#stopping)
- [The supervisor](#the-supervisor)
- [The operational log](#the-operational-log)
- [Seams for other packages](#seams-for-other-packages)
- [Not yet implemented](#not-yet-implemented)
- [Tests](#tests)

## Starting a home process

`HomeProcess.start(options)` runs C19's start sequence in order and stops at the first failure, which it logs and throws after undoing what the start created:

1. check that the home, `secrets/` and `run/<profile>/` are private (`HOME_MODE`);
2. take the home lock with the caller's `startId`, asking a live holder for its `status` through the update channel within 2 seconds (`HOME_RUNNING`, `HOME_UNRESPONSIVE`);
3. finish an interrupted update from the journal ([interrupted updates](#interrupted-updates));
4. write a new start token with `writeNewStartToken` and register it with the log's redactor;
5. listen on the update channel, which answers `status` with `starting` from here;
6. launch the supervisor when `options.supervisor` is set;
7. boot the Host through `options.host`;
8. the confinement probes are not run yet ([not yet implemented](#not-yet-implemented));
9. enter `running`.

An `exit` listener removes this start's token file and socket and releases the lock while each is still this start's, however the process ends. A second start for the same profile finds the lock held and fails with `HOME_RUNNING`; the desktop app's `profiles/desktop/lock` is a different file, which the home process never reads or writes.

## The update channel

`listenUpdateChannel` serves `@delo/home`'s token channel with C19's limits: one request line of at most 16,384 bytes per connection, arriving within 5 seconds (`REQUEST_TOO_LARGE`, `REQUEST_TIMEOUT`), and at most 8 open connections (`BUSY`). The token is compared in constant time before anything else in the line is read; a missing, malformed, wrong or previous start's token receives `UNAUTHENTICATED` with no other field, and refusals are logged without the presented value at most once per second. `checkUpdateRequest` then checks the closed schema: an unknown `op`, an unknown field at any depth, a `v` other than 1 or a value outside its type is refused with `SCHEMA_VIOLATION`, so a request names at most a version, never a path, an archive, a URL or a command. A request runs on when its caller disconnects, and that caller's connection no longer counts towards the 8.

Confined commands reach neither the channel nor the token where C1's rules hold: `delorun` boots the CLI profile with upstream's local sandbox provider set to protect the home and deny the channel's socket ([the CLI's start](../../apps/cli/README.md#the-home-process)); under Landlock a confined command can connect but cannot read the token, so its request fails `UNAUTHENTICATED`. `sendHomeRequest` is the client side for `delorun`: it reads the token file when it sends a request and retries a `BUSY` answer. `updateChannelProbe` is the holder probe the lock uses. The Host reaches the channel only through the `UpdateChannelAccess` it receives at boot, which holds the token in memory; the studio's "Update now" and rollback go through it.

## The update handshake

`UpdateHandshake` runs C19's phases, writing the journal `run/<profile>/update.json` at mode 0600 at the start of each phase from `snapshot` on. One update, prepare or rollback runs at a time (`UPDATE_IN_PROGRESS`).

- **`update.prepare`** runs the store's `checking`, `installing` and `reporting` phases and returns a `reportId` and the report, kept for 600 seconds (`REPORT_EXPIRED` after that or once applied).
- **`update.apply`** runs `snapshot`, then `waiting`: from its start, the Host's chat gate refuses new turns with `UPDATE_PENDING`. `drain` waits for running chats to reach zero for at most `drainTimeoutS` (`DRAIN_TIMEOUT`), `abort-if-busy` ends `aborted` with `CHATS_RUNNING` when a chat runs, and `cancel` cancels running turns and jobs and waits for them to end. `update.cancel` ends an update that has not begun `switching`, with `current` unchanged.
- **`switching`** runs only while the gate reports no running chat and still refuses new turns. The home process stops its Host and its supervisor, the store writes `previous` and then `current`, and the successor starts ([the handover](#the-handover)).
- **`health-check`**: the successor answers `ready` or `failed` within 120 seconds. On `ready` the update ends `committed`. On `failed`, an exit or silence, the successor is stopped, both pointers and the profile snapshot are restored, this process boots its Host on the old runtime again and the update ends `rolled-back` with `HEALTH_CHECK_FAILED`.
- **`rollback`** runs the same phases to the version `previous` names, installing nothing (`NO_PREVIOUS` without one).

## The handover

The predecessor starts the successor from the target's runtime with the store's command and a pipe inherited as file descriptor 3, in its own process group so a signal to the requester's terminal does not reach it, and writes one handover line: the home, the profile, both versions, the start id it assigns to the successor and the plugins the report named as disabled. No token passes. `HomeProcess.takeOver` boots the successor's Host in `standby` and checks it: the boot completes, it disables no plugin the report did not name and its studio listener answers. It answers `ready` or `failed`. On `ready` the predecessor rewrites the lock atomically with the successor's process id and start id (`HomeLock.handOver`), sends the requester the final `committed` line, closes its channel, removes its token file and writes `commit`; the successor then adopts the lock, writes a new start token, listens, launches its supervisor, enters `running` and removes the journal. A successor whose predecessor dies before `commit` takes over only when the lock already names it.

## Interrupted updates

A requester that disconnects never changes a running update. At each start, step 3 reads the journal a killed home process left: a phase before `switching`, or `current` still naming `from`, means nothing switched and the journal is removed. With `switching` or `health-check` and `current` naming `to`, which this process runs, the start's own Host boot is the health check of `to`; when it fails, the start restores `current` to `from` (with `previous` naming `to`), restores the profile snapshot, removes the journal, starts a home process from `from` with the store's command and fails with `HEALTH_CHECK_FAILED`.

## Stopping

`stop` with `drain` refuses new turns and waits for running chats for at most 1,800 seconds; `cancel` cancels them first. The final line is sent before the process closes the Host, removes the token file, closes the channel, stops the supervisor and releases the lock, in that order. A stop while an update or rollback runs is refused with `UPDATE_IN_PROGRESS`. `HomeProcess.shutdown` runs the same order at once, for a termination signal.

## The supervisor

When the machine is set up for Docker, `launchSupervisor` spawns `@delo/supervisor`'s entry module with the command in `SupervisorSetup` and writes one launch line to the pipe on file descriptor 3 with this start's home, profile, start id and token, the verified manifest's images and the supervisor's timing ([the supervisor's launch](../supervisor/README.md#launching-the-supervisor)). The token never appears in its command line or environment. Ending the pipe stops the supervisor; the next start launches a new one with the new token, which refuses the previous start's.

## The operational log

`openHomeLog` opens the `home-<profile>` surface with a redactor; every record carries the start id. The start token is registered with the redactor before the channel listens, and `captureHomeOutput` captures the process's standard output and standard error into the same log, passing them through to a terminal in `delorun start --foreground`. A record names a request's `op` and outcome, never its body. C20's denial suite runs over this surface through `tests/log-driver.ts`.

## Seams for other packages

`src/seams.ts` declares what the home process calls outside this package:

| Interface | Implemented by | Until it lands |
| --- | --- | --- |
| `RuntimeStore`: `pointers`, `prepare` (checking, installing, reporting), `reportRollback`, `switchTo` (C1's `previous`-then-`current` order), `restore` and `homeCommand` (the command that starts a home process from a version, as a successor or a fresh start; its process must be the home process itself, so the lock's process id names it) | `delo/packages/runtime-store` (WP3.3) | the CLI's home process has none: `update.prepare` is refused with `VERIFY_FAILED`, `update.apply` with `REPORT_EXPIRED` and `rollback` with `NO_PREVIOUS`, and `status` reports the running version as `current` |
| `ProfileSnapshots`: `save` in `snapshot`, `restore` after a failed health check | C3's profile history | as above |
| `HostRunner` and `RunningHost`: boot, disabled plugins, studio health, close | `delorun start` with upstream's profile runner | — |
| `ChatGate`: running chats, `hold` (refuse new turns and hold scheduled deliveries), `idle`, `cancelAll`; `CountingChatGate` is an implementation the Host feeds | the Host's update plugin in `@delo/bundle-local` | the CLI's Host counts no running chats |

The specs drive the handshake through a fixture store in `tests/support.ts`, which keeps C1's pointer files and starts successors from `tests/fixtures/home-entry.ts`.

## Not yet implemented

- The runtime store, the profile history and the Host's chat gate, as the table above states. Until the chat gate lands, `delorun stop` does not wait for a running chat.
- Step 8's confinement probes and their results, and `delorun verify`'s report of a dialect that cannot enforce C1's rules. The home process wraps no confined command itself yet; the probes, when they land, retry once a Landlock wrap refused with exit code 125 because an entry on the path to the home changed between the wrap and the launch, before reporting it.
- Start at login (`--at-login`), `delorun status --follow`, `delorun update` and `delorun recover`.
- The Windows named pipe with C1's DACL: the channel listens only on a Unix socket.

## Tests

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/home-process` runs the specs: one home process per profile, the token on each start and the refusal of a previous start's, the closed schema and the limits, the update that waits for a running chat, `abort-if-busy` and `update.cancel`, a requester killed in `waiting` and in `health-check`, the rollback after a failed health check, interrupted updates, the desktop app's independence, the Host's way to the channel, the supervisor launch and the drain timeout on a fake clock. The confinement specs run each sandbox dialect the host provides through upstream's sandbox provider, configured as `delorun` configures the CLI profile's (the home protected with C1's read exemptions, the channel's socket denied), and skip Landlock, with the reason, where its launcher is not usable; one spec applies C1's bwrap mechanism as the contract states it to show that the socket and the token file lie where it hides them. `delo/apps/cli`'s real-runner spec runs the same denial under a started CLI profile.
