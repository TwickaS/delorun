---
description: "Contract C19: the home process that holds a CLI profile's lock and runs its Host, delorun start, stop and status, start at login, the update channel's protocol with its per-start token, how running chats drain before the runtime switches, the handover and health check, interrupted updates, rollback, and the desktop app's independent updates."
---

# C19 Home process and update handshake

English | [中文](c19-home-process.zh.md)

## Summary

This contract defines the background process that keeps a person's CLI home running and the handshake through which an update reaches it. One home process per CLI profile holds that profile's lock under `~/.delo`, runs its Host and writes a new start token each time it starts. `delorun update` and the studio's "Update now" reach it through the update channel, a socket under `~/.delo` that accepts only requests carrying the current token. An update waits until no chat runs on the old runtime, hands the profile to a process on the new runtime, checks that it is healthy and rolls back when it is not, so an interrupted update always leaves one whole version current. The desktop app keeps upstream's own Host and profile and updates on its own. The types package [`@delo/contract-home-process`](../../packages/contract-home-process/README.md) carries the protocol, states and limits.

## Contents

- [The home process](#the-home-process)
- [Commands](#commands)
- [Start at login](#start-at-login)
- [The update channel](#the-update-channel)
- [Requests and responses](#requests-and-responses)
- [The update handshake](#the-update-handshake)
- [Interrupted updates](#interrupted-updates)
- [Rollback](#rollback)
- [The desktop app](#the-desktop-app)
- [Limits](#limits)
- [Errors](#errors)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)
- [Enforcement per platform and dialect](#enforcement-per-platform-and-dialect)

## The home process

The home process is one operating-system process per CLI profile. It runs the profile's Host in the same process, on the runtime that [C1](c01-home-layout.md)'s `current` pointer names, and it is a separate process from the Docker supervisor ([C9](c09-runtime-supervisor.md)).

- **Ownership.** It holds `run/<profile>/home.lock` ([C1](c01-home-layout.md)) for its whole life, so a second start for the same profile finds the lock held and does not start a second Host.
- **Detachment.** `delorun start` starts it detached from the terminal, with standard input closed and standard output and standard error routed into its operational log ([C20](c20-operational-logs.md)).
- **States.** `starting`, `running`, `waiting` (an update waits for running chats), `switching` (the handover to a new runtime runs), `stopping`. A successor process started by a handover is in `standby` until the handover completes.
- **Start sequence.** A start runs these steps in order and stops at the first failure, which it writes to its log and to the starting terminal:
  1. check the modes of the home, `secrets/` and `run/<profile>/` ([C1](c01-home-layout.md));
  2. take the home lock, or stop with `HOME_RUNNING` or `HOME_UNRESPONSIVE`;
  3. finish an interrupted update from the update journal ([interrupted updates](#interrupted-updates));
  4. write a new start token ([C1](c01-home-layout.md));
  5. listen on the update channel, which answers `status` with `starting` from this point;
  6. start the Docker supervisor when the machine is set up for Docker ([C9](c09-runtime-supervisor.md));
  7. boot the Host;
  8. run [C1](c01-home-layout.md)'s confinement probes and record their results;
  9. enter `running`.
- **Clean stop.** The process closes the Host, removes the token file, closes the update channel, stops the supervisor it started, removes the lock and exits.

## Commands

- **`delorun start`** starts the home process for the profile and waits until it reports `running`, for at most 120 seconds; a start that does not reach `running` prints the failure and the log's location. When a live home process already answers `status`, the command prints its state and exits 0. `--foreground` runs the process in the terminal and also writes its log. `--at-login` installs the login item first ([start at login](#start-at-login)).
- **`delorun`** with no arguments runs setup on a home without a CLI profile; otherwise it starts the home process as `delorun start` does and opens the studio.
- **`delorun stop`** sends `stop` with the mode `drain`: the home process refuses new turns and waits for running chats for at most 1,800 seconds, then stops. `--now` sends the mode `cancel`, which cancels running turns and background jobs through upstream's cancellation and then stops. `--at-login` also removes the login item. With no home process running, the command prints that and exits 0.
- **`delorun status`** prints the state, process id, `startId`, the `current`, `previous` and running runtime versions, the launcher version, the update phase if one runs, the number of running chats and whether the login item is installed. `--json` prints the `status` response. It exits 0 when the home process runs, 3 when none runs and 1 on an error.

## Start at login

Start at login is off by default. The person turns it on with `delorun start --at-login` or the setup question, and off with `delorun stop --at-login`.

| Platform | Login item |
| --- | --- |
| Linux | the systemd user unit `~/.config/systemd/user/delorun-<profile>.service` |
| macOS | the launch agent `~/Library/LaunchAgents/com.delorun.home.<profile>.plist` |
| Windows | the per-user scheduled task `delorun-home-<profile>`, triggered at logon |

- Each item runs `<home>/bin/delorun start --foreground --profile <profile>` from [C1](c01-home-layout.md)'s launcher copy, so it needs neither npm nor the network.
- After a failure the item restarts the process at most 3 times within 300 seconds, then stays stopped until the next login or a manual start.

## The update channel

The update channel is the socket [C1](c01-home-layout.md) places at `run/<profile>/update.sock`, or the named pipe [C1](c01-home-layout.md) names on Windows. It carries every request that reads or changes the home process's state.

- **Callers.** It serves two callers: the person's `delorun` command, which reads the token file, and the Host's update plugin, which acts for a studio session that the studio's own authentication admitted (upstream's loopback authentication, or C4's admission on a reach listener) and attaches the token it holds in memory. The studio's "Update now" reaches the home process only through this channel.
- **The token check.** The first line of each connection is a request with the field `token`. The home process compares it in constant time with the current start's token. A missing, malformed, wrong or previous start's token receives `UNAUTHENTICATED`, and the connection closes; that response carries no other information.
- **Framing.** Each connection carries one request, encoded as one line of UTF-8 JSON of at most 16,384 bytes, and the response lines that answer it, each one JSON object followed by a newline. The home process closes the connection after the final response line.
- **Timing.** A request line that has not arrived 5 seconds after the connection opens closes the connection with `REQUEST_TIMEOUT`. At most 8 connections are open at once; a further connection is closed at once with `BUSY`.
- **Logging.** A refused authentication is logged without the presented value, at most one line per second; further refusals in that second are counted in the next line.

## Requests and responses

Every request has the fields `v` (the protocol version, 1), `token`, `op` and, where the operation takes them, `args`. A field the operation does not define is refused with `SCHEMA_VIOLATION`. No operation accepts a file path, an archive, a URL or a command: an update names only a version, and the home process obtains and verifies that version itself ([C1](c01-home-layout.md), [C2](c02-release-manifest.md), [C18](c18-release-log.md)).

| `op` | `args` | Response |
| --- | --- | --- |
| `status` | none | one line: `state`, `pid`, `startId`, `runtime` (`current`, `previous`, `running`), `chats` (the number running), `update` (the phase and target, when an update runs) |
| `update.prepare` | `target`: a version, or omitted for the newest release on the person's channel | progress lines while the version is fetched and verified, then one line with `reportId` and the update report ([C3](c03-update-report.md)) |
| `update.apply` | `reportId`; `wait`: `drain`, `abort-if-busy` or `cancel`; `drainTimeoutS`: 60 to 86,400, default 1,800 | progress lines for each phase, then one final line with `outcome`: `committed`, `rolled-back` or `aborted`, and a reason code |
| `update.cancel` | none | one line; an update still in `waiting` returns to `running` with the runtime unchanged |
| `rollback` | `wait` and `drainTimeoutS` as for `update.apply` | as `update.apply`, with the target `previous` |
| `stop` | `mode`: `drain` or `cancel` | progress lines, then one final line before the process exits |

- **Response lines.** Each line has `ok` (a boolean); a failed line has `error`, a code from [errors](#errors), and a progress line has `phase`. A report expires 600 seconds after `update.prepare` returns it; `update.apply` with an expired or unknown `reportId` fails with `REPORT_EXPIRED`.
- **One at a time.** Only one update or rollback runs at a time; a second one fails with `UPDATE_IN_PROGRESS`.
- **Detached requesters.** A requester that disconnects does not change a running update. `delorun status --follow` shows the phase of the update in progress.

## The update handshake

An update moves a profile from the running version, `from`, to the target version, `to`. The phases run in this order:

1. **`checking`.** The release metadata ([C2](c02-release-manifest.md)) and the log entry ([C18](c18-release-log.md)) of `to` are fetched and checked.
2. **`installing`.** `to` is installed into the runtime store with [C1](c01-home-layout.md)'s verification, unless it is already installed and its files match its manifest.
3. **`reporting`.** The update report ([C3](c03-update-report.md)) is computed against `to` and returned by `update.prepare`. Nothing after this phase runs until `update.apply` names the report.
4. **`snapshot`.** A profile history version named for the update is saved, including the home patch ([C3](c03-update-report.md)).
5. **`waiting`.** A running chat is a session of this Host with an active turn or a running background job. From the start of this phase, new turns are refused with `UPDATE_PENDING`, which the studio shows with a cancel action, and scheduled deliveries are held until the update ends. With `drain`, the phase waits for the number of running chats to reach zero for at most `drainTimeoutS`, then the update ends `aborted` with `DRAIN_TIMEOUT`. With `abort-if-busy`, the update ends `aborted` with `CHATS_RUNNING` when any chat runs at the start of the phase. With `cancel`, running turns and jobs are cancelled through upstream's cancellation, and the phase continues when they have ended.
6. **`switching`.** With no chat running and new turns refused, the predecessor stops its Host and the supervisor it started, writes [C1](c01-home-layout.md)'s `previous` and `current` pointers, writes the journal and starts the successor from `to` in `standby`. The predecessor passes the handover over a pipe inherited as file descriptor 3, never through a command line or environment variable.
7. **`health-check`.** The successor boots its Host. It passes when the Host's boot completes within 120 seconds, the plugins it disables at boot are a subset of those the report named, and the studio listener answers its health request.
8. **`committed`.** The successor reports `ready` over the pipe. The predecessor rewrites the lock atomically with the successor's process id and `startId`, then closes its update channel. The successor writes a new start token, listens on the update channel, starts the supervisor, enters `running` and removes the journal. The predecessor exits.

**Failure in `switching` or `health-check`.** When the successor exits, sends `failed` or does not report `ready` within 120 seconds, the predecessor stops it, restores both pointers to their values before the update, boots its own Host on `from` again and returns to `running`. The update ends `rolled-back` with the reason, and [C3](c03-update-report.md)'s rollback steps restore the profile snapshot.

**The rule this enforces.** `current` switches only after the waiting phase has seen zero running chats with new turns refused, so the runtime never switches under a running chat. The studio is unavailable from the start of `switching` until the successor's listener or the restored Host answers.

## Interrupted updates

The home process writes the journal `run/<profile>/update.json`, mode 0600, at the start of each phase from `snapshot` on: `{"v":1,"from":"<version>","to":"<version>","previous":"<version>","phase":"<phase>","startedAt":"<RFC 3339 UTC time>"}`. `previous` is the version [C1](c01-home-layout.md)'s `previous` pointer named before the update, and the field is absent when no `previous` pointer existed.

- **A killed requester.** Killing the terminal or process that sent the request does not stop the update; the home process keeps running and finishes the update or rolls it back.
- **A killed home process.** Every pointer write is [C1](c01-home-layout.md)'s atomic rename, so `current` always names a whole, installed version. At the next start, step 3 of the start sequence reads the journal:
  - with a phase before `switching`, it removes the journal, and nothing has changed;
  - with `switching` or `health-check` and `current` naming `to`, the start runs the health check on `to`; when it fails, it restores both pointers to their values before the update (`current` to `from`, and `previous` to the journal's `previous`, or removes `previous` when the journal has none), starts again from `from` and logs the rollback;
  - with `current` naming `from`, the start restores `previous` to the journal's `previous` (or removes `previous` when the journal has none — the kill between the two pointer writes left it holding `from`), runs `from` and removes the journal.
- **Installed versions.** A version installed by an interrupted update stays in the store as a non-current version until [C1](c01-home-layout.md)'s retention removes it.

## Rollback

- **CLI runtime.** `delorun recover --runtime previous`, or the studio's rollback, sends `rollback`. It runs the handshake's `reporting`, `snapshot`, `waiting`, `switching` and `health-check` phases with the target `previous` and installs nothing. After it commits, `current` names the version rolled back to and `previous` names the version rolled back from. With no home process running, `delorun recover --runtime previous` takes the home lock and `store.lock` and swaps the two pointers directly.
- **Automatic rollback.** A failed health check during an update, or at the start after an interrupted update, restores the pointers as the handshake states.
- **Profile.** [C3](c03-update-report.md) owns the rollback triggers and the restore of the profile snapshot; this contract owns the runtime switch.
- **Desktop app.** The desktop app's rollback does not use the runtime store. The app keeps the previous signed release in its update cache; its feed refuses an automatic downgrade and accepts a rollback the person requests to a signed, logged earlier release ([C2](c02-release-manifest.md)). A rollback reinstalls that release from the cache and restores the desktop profile from its history.

## The desktop app

- The desktop Host keeps upstream's `desktop` profile and runs on the desktop app's own bundled runtime. It takes no CLI lock, has no start token and has no update channel.
- `delorun update` and `delorun recover` never stop, drain or switch a desktop Host. A running desktop Host never blocks `delorun start`.
- The desktop app updates through its own feed ([C2](c02-release-manifest.md)), with its own update report entry ([C3](c03-update-report.md)).
- Both surfaces use the sessions and workspaces under the home as upstream's surfaces share them. The desktop Host's chats do not count as running chats for a CLI update, because they do not run on the CLI runtime.

## Limits

| Limit | Value |
| --- | --- |
| Home processes per CLI profile | 1 |
| `delorun start` wait for `running` | 120 seconds |
| Request line | at most 16,384 bytes |
| Time from connect to request line | 5 seconds |
| Open connections on the update channel | at most 8 |
| Refused-authentication log lines | at most 1 per second |
| Update report lifetime | 600 seconds |
| `drainTimeoutS` | 60 to 86,400 seconds, default 1,800 |
| `delorun stop` drain | 1,800 seconds |
| Successor `ready` and health check | 120 seconds |
| Login item restarts | at most 3 within 300 seconds |
| Concurrent updates or rollbacks per profile | 1 |
| Protocol version `v` | 1 |

## Errors

| Code | Meaning |
| --- | --- |
| `UNAUTHENTICATED` | The request's token is missing, malformed, wrong or from a previous start |
| `SCHEMA_VIOLATION` | The request has an unknown `op`, an unknown field or a field of the wrong type |
| `REQUEST_TIMEOUT` | No request line arrived within 5 seconds |
| `REQUEST_TOO_LARGE` | The request line exceeds 16,384 bytes |
| `BUSY` | 8 connections are already open |
| `UPDATE_IN_PROGRESS` | An update or rollback already runs |
| `REPORT_EXPIRED` | `update.apply` named a report that is unknown or older than 600 seconds |
| `UPDATE_PENDING` | A new turn was refused because an update is waiting for running chats |
| `CHATS_RUNNING` | `abort-if-busy` found running chats |
| `DRAIN_TIMEOUT` | Running chats did not reach zero within `drainTimeoutS` |
| `HEALTH_CHECK_FAILED` | The successor failed its health check or did not report `ready` within 120 seconds |
| `VERIFY_FAILED` | The target's metadata, log entry or files failed [C1](c01-home-layout.md)'s, [C2](c02-release-manifest.md)'s or [C18](c18-release-log.md)'s checks |
| `NO_PREVIOUS` | A rollback was requested and no `previous` pointer exists |

## Consumers

- `delo/packages/home-process`: the home process, the update channel, the handshake, the journal and the login items.
- `delo/apps/cli`: `delorun`, `delorun start`, `stop`, `status`, `update` and `recover`.
- `delo/packages/runtime-store`: the pointer writes and installs the handshake calls ([C1](c01-home-layout.md)).
- `delo/packages/logs`: the home process's operational log ([C20](c20-operational-logs.md)).
- The Host's update plugin in `@delo/bundle-local`: "Update now" and the studio's rollback.
- The update report and its screens ([C3](c03-update-report.md)), which read the phases and outcomes.

## Compatibility

- The protocol version `v` is 1. A home process answers a request with an unknown `v` with `SCHEMA_VIOLATION`. A change that removes or renames an operation, a field or a phase raises `v`, and a runtime that raises it accepts both versions for one release, so a `delorun` from the previous release can still update it.
- New operations, optional fields and new error codes keep `v`; callers ignore unknown response fields.
- The login item paths and the command flags above are external interfaces; changing one is a breaking change with an upgrade guide under `delo/docs/upgrade-guide/`.
- The types package follows Delo's version and changes in the same pull request as this page.

## Security

### Requirements

1. The update channel's socket lies under the home, which confined commands cannot read or connect to wherever [C1](c01-home-layout.md)'s rules are enforced. Where a dialect cannot enforce them, `delorun verify` reports it through the `confinement-rule` check of [C15](c15-verification-checks.md).
2. The channel accepts a request only with the token of the current home-process start, compared in constant time; a missing, wrong or previous start's token is refused with `UNAUTHENTICATED` and nothing else.
3. The channel serves only the person's `delorun` command and the Host's update plugin acting for an authenticated studio session.
4. No request carries a path, an archive, a URL or a command, so a caller holding the token can choose only a version that the home process itself fetches and verifies.
5. The home lock is per profile. The desktop Host neither takes it nor joins the drain, and `delorun update` never switches the desktop app.
6. `current` switches only when no chat runs on the old runtime and new turns are refused; an interrupted update leaves one whole version current, and a failed health check restores the version that ran before.
7. Request size, request deadline and connection count are limited, and refused authentications are logged without the presented value. Under Landlock, a confined command can still open connections that reach those limits; that affects availability only, and `delorun` retries a `BUSY` connection.
8. The handover passes over an inherited pipe; the token is never in a command line, an environment variable, a response or a log.
9. The protection rests on confining the agent's commands. A process of the person's user outside the sandbox can run `delorun update` itself, and this contract claims no protection against it. No root-owned helper exists.
10. A command reaches the update channel with the token only when it runs unconfined. A `danger-full-access` escalation is approved only through [C1](c01-home-layout.md)'s escalation prompt, which states that full access reaches Delo's home, its tokens, the Docker supervisor and the update channel.

### Denial tests

| Test | Proves |
| --- | --- |
| `update-waits-for-chat` | An update applied while a fixture chat's turn runs stays in `waiting` and leaves `current` unchanged until the turn ends; a new turn in that time is refused with `UPDATE_PENDING`; with `abort-if-busy` the update ends `aborted` with `CHATS_RUNNING` |
| `update-channel-connect-denied` | On each dialect that enforces [C1](c01-home-layout.md)'s `home-connect`, a confined workspace command's connect to the update channel fails and it cannot read the start token |
| `update-channel-token-required` | A request with no token, with a wrong token and with the previous start's token each receives `UNAUTHENTICATED` and no other field |
| `update-channel-landlock` | Under Landlock, a confined workspace command's connect to the update channel succeeds, its request fails with `UNAUTHENTICATED` because it cannot read the token, and `delorun verify` reports that state |
| `update-channel-not-enforced-reported` | On a fixture dialect that cannot enforce [C1](c01-home-layout.md)'s rules, `delorun verify` reports them as `not-enforced` |
| `update-request-fields` | A request with a path, URL or command field, or an unknown `op`, is refused with `SCHEMA_VIOLATION` and changes nothing |
| `update-request-limits` | A request line above 16,384 bytes, a connection silent for 5 seconds and a ninth connection are each closed with their codes |
| `desktop-independent` | With a fixture desktop Host running, `delorun start` succeeds, and `delorun update` leaves the desktop process running and the desktop profile byte-identical |
| `requester-killed` | Killing the requesting terminal in each phase leaves the home process running and `current` naming a whole version |
| `home-killed-mid-switch` | Killing the home process in `switching` and in `health-check` leaves `current` naming a whole version, and the next start with a failing `to` rolls back to `from` |
| `health-check-rollback` | A successor that disables a plugin the report did not name is rolled back, and the predecessor's Host runs again on `from` |
| `escalation-prompt-before-full-access` | A confined workspace command that requests `danger-full-access` to send an update request is shown [C1](c01-home-layout.md)'s escalation prompt, which names the update channel; while the prompt is declined or unanswered the command stays confined and its request is refused or never sent |

### What this does not prove

- **Landlock.** A confined command connects to the update channel; the refusal rests only on the token being unreadable. Such a command can also hold connections up to the channel's limits, which affects availability.
- **Full access.** A command approved for `danger-full-access` can read the token and send any request a `delorun` command can send, within the closed request set.
- **Process memory.** On macOS and Windows the protection of the home process's memory rests on the operating system's own rules for reading another process's memory, which no Delo test proves.
- **The person's own processes.** A process of the person's user outside the sandbox can read the token and run `delorun update` itself.

## Enforcement per platform and dialect

The update channel inherits [C1](c01-home-layout.md)'s rules for confined commands; `delorun verify` reports them as [C1](c01-home-layout.md)'s table states, and this table names the channel's resulting behaviour.

| Platform and dialect | A confined command's connect | Its request |
| --- | --- | --- |
| Linux, bwrap | fails: the socket is hidden under the tmpfs | not sent |
| Linux, Landlock | succeeds: Landlock cannot deny it | refused with `UNAUTHENTICATED`: the token is unreadable |
| macOS, Seatbelt | fails: `remote unix-socket` path literal | not sent |
| Windows, windows-acl | fails where `windows-pipe-connect-denied` passes: the pipe cannot be opened for writing | not sent |
| No sandbox, or `danger-full-access` | succeeds | accepted when the command reads the token file, as for any process of the person's user |

- **Login items.** The systemd user unit, the launch agent and the scheduled task run as the person's user with that user's access; none runs with elevated rights.
- **Process inspection.** The token is held only in memory and in the token file, never in a command line or the environment, which same-user processes can list on macOS and Linux. bwrap gives confined commands their own process namespace, and Landlock denies a confined command tracing a process outside its domain.
