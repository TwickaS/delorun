---
description: "Contract C19: the home process that holds a CLI profile's lock and runs its Host, delorun start, stop and status, start at login, the update channel's protocol with its per-start token, how running chats drain before the runtime switches, the handover and health check, interrupted updates, rollback, and the desktop app's independent updates."
---

# C19 Home process and update handshake

English | [中文](c19-home-process.zh.md)

## Summary

This contract defines the background process that keeps a person's CLI home running and the handshake through which an update reaches it. One home process per CLI profile holds that profile's lock under `~/.delo`, runs its Host and writes a new start token each time it starts. `delorun update` and the studio's "Update now" reach it through the update channel, a socket under `~/.delo` that accepts only requests carrying the current token. An update waits until no chat runs on the old runtime, hands the profile to a process on the new runtime, checks that it is healthy and rolls back when it is not, so an interrupted update always leaves one whole version current. The desktop app keeps upstream's own Host and profile and updates on its own. The types package [`@delo/contract-home-process`](../../packages/contract-home-process/README.md) carries the protocol, states and limits.

## Status

The home process, the update channel with its token check and fixed request set, the handshake, interrupted updates and rollback are built and reached by `delorun`, `delorun start`, `stop`, `status`, `update` and `recover`; the supervisor launch, the confinement probes, start at login, the studio's caller and the Windows pipe are not.

- **Built and reached:** the lock, the per-start token compared in constant time, the Host's channel token and `studio.open-token`, which `delorun open`, the start and setup's ending use, the update channel on the Unix socket `run/<profile>/update.sock` with its request, size, time and connection limits, the drain with the CLI profile's turn refusal, the handover over an inherited pipe, the health check and automatic rollback, and the journal that finishes an interrupted update at the next start.
- **Not built:** step 6 of the start sequence, because `delorun start` passes the home process no supervisor ([C9](c09-runtime-supervisor.md)); step 8, the confinement probes, and `delorun verify` reporting their results; start at login, `--at-login` and the launcher copy it runs; the Host's update plugin, so the studio's "Update now" and rollback do not exist and the channel serves only the `delorun` command; `delorun status --follow`; the named pipe on Windows: the channel takes the same socket path on every platform, no test shows it opening on Windows, and windows-acl has no rule that denies a confined command the connect or the read of the token; the escalation prompt wording requirement 10 names ([C1](c01-home-layout.md)).
- **Not reached by Delo's sandbox rules:** a command that runs under `danger-full-access`, which a `delorun headless` task reaches only for a working directory with a recorded full-access grant, and a command that a `delorun plugin` operation runs, can read the start token and connect to the channel while a home process runs; the closed request set of requirement 4 still applies to it.

The requirements and denial tests below that this list names as not built or reached by nothing protect no one until a change builds and wires them.

## Contents

- [Status](#status)
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
- **Other profiles.** Home processes of different CLI profiles may run at the same time: each has its own lock, token, channels and studio port, and they share the home's chat data and `current` ([C1](c01-home-layout.md)). Each home process therefore registers under C1's `run/data-users/` as a shared user with its profile before it takes its lock, and keeps the registration until it exits. It refuses to start while an exclusive user such as `delorun trash` or an offline `delorun recover rollback` is registered or an update or a rollback of another profile is between its snapshot and its end. An update's prepare, session-data copy, restore and runtime switch, and every rollback but a profile-only one, refuse with `CHATS_RUNNING` while another profile's home process or another user is registered, naming it and its profile; the process's own registration never counts. `update.apply` checks before it writes the update record and again in `switching`, after the record is written and right before the Host stops, whether or not a copy is taken: a user that registered before the record existed is found by the second check, and one that registers later finds the record and refuses itself.
- **Detachment.** `delorun start` starts it detached from the terminal, with standard input closed and standard output and standard error routed into its operational log ([C20](c20-operational-logs.md)).
- **States.** `starting`, `running`, `waiting` (an update waits for running chats), `switching` (the handover to a new runtime runs), `stopping`. A successor process started by a handover is in `standby` until the handover completes.
- **Start sequence.** A start runs these steps in order and stops at the first failure, which it writes to its log and to the starting terminal:
  1. check the modes of the home, `secrets/` and `run/<profile>/` ([C1](c01-home-layout.md));
  2. take the home lock, or stop with `HOME_RUNNING` or `HOME_UNRESPONSIVE`;
  3. run the [pre-start steps](#host-invariants), then finish an interrupted update from the update journal ([interrupted updates](#interrupted-updates)); a process that runs outside the runtime store stops here with `NO_RUNTIME_STORE` when the record is not `committed`, and leaves the record in place;
  4. write a new start token ([C1](c01-home-layout.md));
  5. listen on the update channel, which answers `status` with `starting` from this point;
  6. start the Docker supervisor when the machine is set up for Docker ([C9](c09-runtime-supervisor.md)); not built, so no supervisor starts;
  7. boot the Host through Delo's one composition and hold it to the [Host invariants](#host-invariants);
  8. run [C1](c01-home-layout.md)'s confinement probes and record their results; not built, so no probe runs;
  9. enter `running`.
- **Clean stop.** The process closes the Host, removes the token file, closes the update channel, stops the supervisor it started, removes the lock and exits. A Host that fails to close is logged, and the later steps still run.
- **Failed start.** A start that fails once its Host booted, including a Host the [Host invariants](#host-invariants) refuse, stops that Host through its own teardown, which ends no process, waiting at most 5 seconds, and then finishes its failure handling: the rollback of an interrupted update, the release of the lock, the start again and the refusal. When the teardown fails or takes longer, the Host may still use the data: the refusal also names the teardown, nothing is rolled back or started again, the lock stays held, and the process exits 1 once the refusal is reported.
- **Signals.** From the moment a start holds the lock, or a successor starts booting its Host, the process alone answers `SIGTERM` and `SIGINT`; the Host's profile runner installs no signal or fail-loud handler. The first signal runs the clean stop at once, without waiting for chats, and exits 0 for `SIGTERM` and 130 for `SIGINT`. A second signal while that stop runs exits at once with its own code. A signal while the Host boots removes the token, the socket and the lock, and the booting Host ends with the process.

<a id="host-invariants"></a>

### Host invariants

Every Host Delo boots over a home goes through one composition: the foreground start, its detached child, setup's ending, an update's or a rollback's successor and the start after an interrupted update (each runs `delorun start --foreground`), safe mode, and `delorun headless`, which boots the home's `headless` profile, upstream's `headless` template with `@delo/bundle-headless` linked into it. The composition prepares the profile, refuses a profile that skipped a Delo bundle, refuses a `headless` profile that does not load `@delo/bundle-headless`, applies safe mode's filtered layers and overlay, applies the approved plugin content step's overlays, and writes [C1](c01-home-layout.md)'s sandbox overlay last, so it applies over the bundle layers, the profile patch, the home patch and every other overlay. Before any plugin runs the composed rows are checked, and after boot the Loader's rows are checked again:

- each required row, the `sandbox` row and every row a Delo bundle inserts is inserted once, by the bundle that declares it (upstream's `@deepseek-ai/dsh-base` for `sandbox`, a Delo bundle for a Delo row), and runs the plugin that bundle names: a second insert of the id by any other bundle, the profile patch, the home patch or an overlay is refused, because upstream mounts both entries and the later one replaces the row;
- each required row is enabled and active, and safe mode's overlay never exempts one;
- the `sandbox` row's `protectedHome` is the home's real path, its `deniedSockets` hold every socket C1 denies, its `escapeSocketDirectories` hold every directory the start names, such as WSL's `/run/WSL`, and it sets no `runnerCommand` or `runnerFailureSignatures`;
- in the CLI profile, each prompt row's switch has the value the recorded prompts answer gives it (Delo's default for "Safer prompts", the parity value for "Same as stock"), and `delo-fetch-guard` and `delo-update-gate` are on, the update gate with `holdUntilChecked`, whose waiting turn ends with `START_CHECK_PENDING` after `checkWaitSeconds` (default 60) if `delorun` has not released it; in the `headless` profile, which has no setup answer, the rows of `@delo/bundle-headless` have Delo's default: `delo-instruction-consent`, `delo-mcp-consent`, `delo-schedule-consent`, `delo-permission-defaults`, `delo-fetch-guard` and `delo-update-gate` are on, the update gate with `holdUntilChecked`, and plugin management protects those rows and the sandbox rows as `@delo/bundle-local` does;
- after boot, each service a required row provides is provided by that row's fiber or a fiber under it, not merely present: `sandbox` by `sandbox`, `fetchGuard` by `delo-fetch-guard`, `deloTurnGate` by `delo-update-gate`, `writeConsent`, `mcpAddConsent` and `scheduleConsent` by their consent rows, and `permissionDefaults` and `sandboxModeGuard` by `delo-permission-defaults`; a service is absent only when its row's switch is off.

A violation stops the start before boot, or stops the booted Host, with one refusal naming each row, the files that set the value and the remedy: remove the setting, or `delorun recover safe-mode`. In the CLI profile and in the `headless` profile the update gate holds the first step of every agent turn until the booted Host passes the check, so no turn's model request is sent before it; a turn still waiting when a refused Host stops is refused with `UPDATE_PENDING`. The gate holds turns only: a model call outside a turn's steps, such as upstream's chat title generation, auto-review and a compaction the person starts, is not held. In the `headless` profile no update or stop waits on the gate; it holds the task's first step until the check passes, so the task starts only after Delo checked the rows and services, and a Host the check refuses is stopped with the task. A guard that asks a person refuses in the `headless` profile, because it composes no approval answerer. In the `headless` profile the full-access consent of `delo-permission-defaults` refuses every switch to full access for a working directory without a full-access grant recorded in the studio. `delorun headless` also refuses such a request early, before boot, when it reads it from `--permission-mode` (`danger-full-access` or a preset that any layer maps to the `danger-full-access` sandbox mode) or `DSH_PERMISSION_MODE=danger-full-access`, each trimmed and case-folded, or when the record of grants cannot be read. A crash of a `delorun headless` run after boot ends the process through the CLI's last-resort handler, which first disposes the Host within its bound. A start never uses upstream's browser handoff, so the studio opens through `studio.open-token` only once the home process runs, after the check.

Before any Host boots, one ordered list of pre-start steps runs: the withdrawal of an interrupted import of a stock DeepSeek Harness home; the completion of an interrupted restore of a session-data copy ([C3](c03-update-report.md)); each of these two turns the start's own data-user registration exclusive while it runs and refuses while another process is registered; on a fresh start, not an update's successor, and on every `delorun headless` run, the profile's one-time changes that the profile's `delo-migrations.json` does not list, none while that record does not read ([C1](c01-home-layout.md#profiles)); the `headless` profile's change `headless-bundle` links `@delo/bundle-headless`, and creates the profile on the first run; and the update notice's check, a slot that does nothing until that feature lands. A home process runs the list once it holds its home lock and before it finishes an interrupted update; `delorun headless` runs the import and notice steps and the profile's one-time changes after it registers as a shared user of the chat data. A step that throws refuses the start.

A Host's launch environment is upstream's `.env` layers, the working directory's and the harness home's, over the environment `delorun` was started with. A layer that sets a `DELO_` name is refused before any layer applies, and the launcher's release roots and the Docker context are read from the environment `delorun` was started with. `delorun headless` takes the `headless` profile and refuses upstream's `--profile`, `--patch`, `--from-default-profile` and configuration dumps; it takes no home lock, because it serves no update channel, and registers as a shared user of the chat data.

## Commands

- **`delorun start`** starts the home process for the profile and waits until it reports `running`, for at most 120 seconds; a start that does not reach `running` prints the failure and the log's location. When a live home process already answers `status`, the command prints its state and exits 0. `--foreground` runs the process in the terminal and also writes its log. `--at-login`, which would install the login item first ([start at login](#start-at-login)), is not built.
- **`delorun`** with no arguments runs setup on a home without a CLI profile; otherwise it starts the home process as `delorun start` does and opens the studio as `delorun open` does.
- **`delorun open`** asks the running home process for a studio link with `studio.open-token` and hands it to the default browser; `--print` prints the link once instead, and `--port <n>` makes it for a loopback port that forwards to the studio. With Delo's composition the link signs in once, within 60 seconds ([C4](c04-admission.md#launch-tokens)). A start prints the studio's address without a token and the line that names `delorun open`; `delorun start --open`, a bare `delorun` and setup's ending open the studio through `studio.open-token` and never read an address from a log. With no home process running, `delorun open` exits 3.
- **`delorun stop`** sends `stop` with the mode `drain`: the home process refuses new turns and waits for running chats for at most 1,800 seconds, then stops. `--now` sends the mode `cancel`, which cancels running turns and background jobs through upstream's cancellation and then stops. A `stop` sent while another waits joins it and gets the same final line; a joining `cancel` first cancels the running chats, so `delorun stop --now` ends a draining stop's wait. An accepted stop always sends its final line and ends the process: a failed cancellation is logged and the stop goes on, and a status that cannot be read is left out of the line. `--at-login` also removes the login item. With no home process running, the command prints that and exits 0. A `--now` stop whose home process sends no final line within 60 seconds, closes the channel without one, or has not exited 120 seconds after accepting is ended by signal: `SIGTERM`, then `SIGKILL` if the process still runs 30 seconds later. Before each signal the command confirms the process as the lock's holder: the lock still holds the record read at the start, and a live process has its `pid` and `processStart`, in its `pidNamespace` where one is recorded. A holder it cannot confirm (no `processStart` recorded, another or an unreadable pid namespace, a different or unreadable start identity, or an unreadable lock) is not signalled; the command names the process id and what to check and exits 1. Windows records no start identity, so there `--now` never signals. The command prints which signal it sent and whether the process exited; after `SIGKILL` it also prints that commands Delorun started may still be running, because a command started in its own systemd scope survives the home process. A process still running 5 seconds after `SIGKILL` exits 1. A home process that refuses the stop, and a drain stop, are never signalled.
- **`delorun status`** prints the state, process id, `startId`, the `current`, `previous` and running runtime versions, the launcher version, the update phase if one runs, and the number of running chats; it shows no login item, because none is built. `--json` prints the `status` response. It exits 0 when the home process runs, 3 when none runs and 1 on an error.

## Start at login

Start at login is not built: `delorun start` and `delorun stop` take no `--at-login` option, setup asks no such question, and no login item is installed. The rules below are the requirement. Start at login is off by default. The person turns it on with `delorun start --at-login` or the setup question, and off with `delorun stop --at-login`.

| Platform | Login item |
| --- | --- |
| Linux | the systemd user unit `~/.config/systemd/user/delorun-<profile>.service` |
| macOS | the launch agent `~/Library/LaunchAgents/com.delorun.home.<profile>.plist` |
| Windows | the per-user scheduled task `delorun-home-<profile>`, triggered at logon |

- Each item runs `<home>/bin/delorun start --foreground --profile <profile>` from [C1](c01-home-layout.md)'s launcher copy, so it needs neither npm nor the network.
- After a failure the item restarts the process at most 3 times within 300 seconds, then stays stopped until the next login or a manual start.

## The update channel

The update channel is the socket [C1](c01-home-layout.md) places at `run/<profile>/update.sock`, or the named pipe [C1](c01-home-layout.md) names on Windows. It carries every request that reads or changes the home process's state.

- **Callers.** It serves the person's `delorun` command, which reads the token file. The Host's update plugin, which would act for a studio session that the studio's own authentication admitted (upstream's loopback authentication, or C4's admission on a reach listener) and attach the token it holds in memory, is not built, so no studio action reaches the channel.
- **The caller rule.** The token a request carries names its caller: the token file's names the person's own command, and the Host's channel token names the Host. Every operation accepts both, except `studio.open-token`, `devices.approve` and `devices.remove`, which the home process refuses for the Host's channel token before it reads anything else (`UNAUTHENTICATED` and `LOOPBACK_REQUIRED`), because the Host acts for sessions on every listener, reach sessions included ([C14](c14-oidc-passkeys.md#tailnet-membership)).
- **The token check.** The first line of each connection is a request with the field `token`. The home process compares it in constant time with the current start's token. A missing, malformed, wrong or previous start's token receives `UNAUTHENTICATED`, and the connection closes; that response carries no other information.
- **The Host's channel token.** The home process creates a second token at each start, holds it only in memory and gives it to the Host in the `UpdateChannelAccess` it receives at boot. The channel accepts it for every operation but `studio.open-token`, which receives `UNAUTHENTICATED` for it.
- **Framing.** Each connection carries one request, encoded as one line of UTF-8 JSON of at most 16,384 bytes, and the response lines that answer it, each one JSON object followed by a newline. The home process closes the connection after the final response line.
- **Timing.** A request line that has not arrived 5 seconds after the connection opens closes the connection with `REQUEST_TIMEOUT`. At most 8 connections are open at once; a further connection is closed at once with `BUSY`.
- **Logging.** A refused authentication is logged without the presented value, at most one line per second; further refusals in that second are counted in the next line.

## Requests and responses

Every request has the fields `v` (the protocol version, 1), `token`, `op` and, where the operation takes them, `args`. A field the operation does not define is refused with `SCHEMA_VIOLATION`. No operation accepts a file path, an archive, a URL or a command: an update names only a version, and the home process obtains and verifies that version itself ([C1](c01-home-layout.md), [C2](c02-release-manifest.md), [C18](c18-release-log.md)).

| `op` | `args` | Response |
| --- | --- | --- |
| `status` | none | one line: `state`, `pid`, `startId`, `runtime` (`current`, `previous`, `running`), `chats` (the number running), `update` (the phase and target, when an update runs) |
| `update.prepare` | `target`: a version, or omitted for the newest release on the person's channel | progress lines while the version is fetched and verified, then one line with `reportId` and the update report ([C3](c03-update-report.md)) |
| `update.apply` | `reportId`; `wait`: `drain`, `abort-if-busy` or `cancel`; `drainTimeoutS`: 60 to 86,400, default 1,800; `dataCopy`: a boolean, the person's choice about the session-data copy | progress lines for each phase, then one final line with `outcome`: `committed`, `rolled-back`, `aborted` or `failed`, and a reason code |
| `update.cancel` | none | one line; an update still in `waiting` returns to `running` with the runtime unchanged |
| `rollback` | `wait` and `drainTimeoutS` as for `update.apply`; `profileOnly`: a boolean | as `update.apply`, with the target the update record's `from`; the final `outcome` is `rolled-back`, `aborted` or `failed` |
| `stop` | `mode`: `drain` or `cancel` | progress lines, then one final line with `status` when it can be read, before the process exits |
| `studio.open-token` | `port`, optional: a loopback port from 1 to 65535 that forwards to the studio | one line: `url`, the studio's loopback address, with `port` in place of the studio's own port when given, and a launch token that the Host mints for this request, and `oneTime`, whether that token works once within 60 seconds ([C4](c04-admission.md#launch-tokens)); `STUDIO_UNAVAILABLE`, with the reason, when no Host runs, the Host serves no studio, its studio listens on an address other than loopback, or it publishes the studio at a public URL |
| `devices.approve` | none; `requestId` and `typedCode` together; or `cancelRequestId` alone | without arguments: opens [C5](c05-device-approval.md#approval-window)'s approval window, claiming a home without an owner for the local person, and answers one line with `closesAt` and `pending` once a request is pending or the window closed; with `requestId` and `typedCode`: [C5](c05-device-approval.md#local-approval)'s local approval, answering one line with the approved `device`; with `cancelRequestId`: cancels that pending request, answering one line with `cancelled` |
| `devices.remove` | `deviceId` | removes one trusted device ([C5](c05-device-approval.md)), ending its sessions and closing its reach connections at once, and answers one line with `removed`, `sessions` and `connections` |

- **Response lines.** Each line has `ok` (a boolean); a failed line has `error`, a code from [errors](#errors), and a progress line has `phase`, or, while `update.prepare` installs the target, `line`: one line of the install's progress with its newline, the same text the launcher prints while it installs a release. A report expires 600 seconds after `update.prepare` returns it; `update.apply` with an expired or unknown `reportId` fails with `REPORT_EXPIRED`. A request that fails in a way the home process does not report on the channel ends without a final line, the failure recorded in the home process's log; the requester treats the request's outcome as unknown, and `delorun update` says so and names `delorun logs home`.
- **`failed`.** An `update.apply` or `rollback` that ends `failed` leaves a rollback the home process may not finish itself; the home process stops once the final line is sent, and the update record stays for the next start ([interrupted updates](#interrupted-updates)).
- **One at a time.** Only one update or rollback runs at a time; a second one fails with `UPDATE_IN_PROGRESS`.
- **Detached requesters.** A requester that disconnects does not change a running update. `delorun status` shows the phase of the update in progress; `delorun status --follow` is not built.

## The update handshake

An update moves a profile from the running version, `from`, to the target version, `to`. The phases run in this order:

1. **`checking`.** The release metadata ([C2](c02-release-manifest.md)) and the log entry ([C18](c18-release-log.md)) of `to` are fetched and checked. Before this phase, `update.prepare` refuses with `GIT_UNAVAILABLE` when git, which saves the snapshot, cannot run; a download that does not finish ends it with `CHANNEL_UNREACHABLE`, and a release that fails a check with `VERIFY_FAILED`.
2. **`installing`.** `to` is installed into the runtime store with [C1](c01-home-layout.md)'s verification, unless it is already installed and its files match its manifest.
3. **`reporting`.** The update report ([C3](c03-update-report.md)) is computed against `to` and returned by `update.prepare`. Nothing after this phase runs until `update.apply` names the report.
4. **`snapshot`.** A profile history version named for the update is saved, including the home patch ([C3](c03-update-report.md)); the update record keeps its id as `snapshot`.
5. **`waiting`.** A running chat is a session of this Host with an active turn or a running background job. From the start of this phase, new turns are refused with `UPDATE_PENDING`, which the studio shows with a cancel action, and scheduled deliveries are held until the update ends. With `drain`, the phase waits for the number of running chats to reach zero for at most `drainTimeoutS`, then the update ends `aborted` with `DRAIN_TIMEOUT`. With `abort-if-busy`, the update ends `aborted` with `CHATS_RUNNING` when any chat runs at the start of the phase. With `cancel`, running turns and jobs are cancelled through upstream's cancellation, and the phase continues when they have ended.
6. **`switching`.** With no chat running and new turns refused, the predecessor first checks `to` as the launcher checks a version before it starts it ([C2](c02-release-manifest.md)'s start check of every file under the anchored root, then [C18](c18-release-log.md)'s release-log start check); a version that fails ends the update `aborted` with `VERIFY_FAILED` before anything changes, and a rollback's target is checked the same way before any step. It then checks again that no other user of the chat data is registered ([other profiles](#the-home-process)); one that is refuses the update with `CHATS_RUNNING` before anything changes, and its record goes as for an update that ended before `switching`. It then stops its Host and the supervisor it started, writes [C1](c01-home-layout.md)'s `previous` and `current` pointers, writes the journal and starts the successor from `to` in `standby`. The predecessor passes the handover over a pipe inherited as file descriptor 3, never through a command line or environment variable. Stopping the Host for a switch ends no process: the predecessor waits for the Host's teardown for at most `drainTimeoutS`, and when the teardown fails or overruns, nothing is switched and no copy is written, the update ends `aborted` with `HOST_STOP_FAILED`, its record goes as for an update that ended before `switching`, and the predecessor boots its Host again; when that boot fails, the predecessor stops and the next start runs `from`. A rollback whose Host does not stop ends the same way before any step, keeping its record.
7. **`health-check`.** The successor boots its Host. It passes when the Host's boot completes within 120 seconds, the plugins it disables at boot are a subset of those the report named, and the studio listener answers its health request.
8. **`committed`.** The successor reports `ready` over the pipe. The predecessor rewrites the lock atomically with the successor's process id and `startId`, then closes its update channel. The successor writes a new start token, listens on the update channel, starts the supervisor, enters `running` and marks the update record `committed`; it then keeps only this update's session-data copy, removes the stash, and removes every installed runtime other than the ones `current` and `previous` name ([C1](c01-home-layout.md)'s retention), a removal that fails being retried by the next update. The predecessor exits.

**The session-data copy.** When the person chose the copy ([C3](c03-update-report.md#data-formats)), `update.apply` checks before `snapshot` that it fits (`DATA_COPY_NO_SPACE` otherwise, with nothing changed) and writes it in `switching` after the Host has stopped and before the pointers change. The update record's `targetStarted` is written and synced before the successor is spawned.

**Running work and the stopped Host.** The CLI's Host counts a running chat from upstream's `agent/status` events, an agent from `running` to `idle`, and from the job registry's events, a job of any owner from `registered` to `settled`; work that began before the Host reported it is not counted. `cancel` cancels each counted turn and kills each counted job through the registry. While the gate is held, the `delo-update-gate` row of `@delo/bundle-local` ([C16](c16-parity-composition.md) switch `update_turn_refusal`) refuses the first step of every new turn with `UPDATE_PENDING`: the turn ends with that message and no model request, and its message is not sent; a later step of a turn that was already running goes on, so the wait ends once the running turns end. A scheduled delivery that falls due while the gate is held is recorded as delivered and its turn is refused like any other; deliveries are not held.

**Child processes after the Host stops.** The Host's child processes do not write the home's `sessions/` or `storages/` after the Host has stopped. A job's child process writes only its own pipes: the Host reads them and appends every session event and storage write itself, and a spill file of long output goes to a per-process directory under the system's temporary directory. Stopping the Host disposes the job registry, which cancels every job and waits for each to settle, and the subprocess provider, which terminates every managed process range and waits until it is empty, so the session-data copy starts only after the last managed child has exited. A disposal that fails or that outlasts `drainTimeoutS` writes no copy and switches nothing: the update ends `aborted` with `HOST_STOP_FAILED`, as `switching` states. A descendant that leaves its managed range is not waited for: on Linux with a user systemd manager the range is a systemd scope, which keeps `setsid` and reparented descendants; on Windows it is a Job object, which a breakaway process leaves; on macOS and on Linux without one it is a process group, which a descendant can leave.

**Failure in `switching` or `health-check`.** When the successor exits, sends `failed` or does not report `ready` within 120 seconds, the predecessor stops it and applies [C3](c03-update-report.md#rollback)'s rollback table with both pointers restored to their values before the update: the profile snapshot, and the copy when the data differs and the target started. The record is rewritten with phase `rolling-back` before the table's first step. The predecessor then boots its own Host on `from` again, removes the record, puts the stashed record back and returns to `running`, and the update ends `rolled-back` with the reason and, when the successor's Host booted and failed one of [C3](c03-update-report.md)'s criteria, `criterion` naming it, such as `H2-host-ready`, which `delorun update` prints. When the table refuses because the data differs, the target started and no copy exists, nothing is restored: the record gains `refused`, the update ends `failed` with `ROLLBACK_NEEDS_DATA_COPY`, `current` names `to`, and the predecessor stops. When a step fails after the rollback began, the update ends `failed`, the record stays `rolling-back`, and the predecessor stops without running its Host again.

**The rule this enforces.** `current` switches only after the waiting phase has seen zero running chats with new turns refused, so the runtime never switches under a running chat. The studio is unavailable from the start of `switching` until the successor's listener or the restored Host answers.

## Interrupted updates

The home process writes the update record `run/<profile>/update.json`, mode 0600, at the start of each phase from `snapshot` on: `{"v":1,"from":"<version>","to":"<version>","previous":"<version>","phase":"<phase>","startedAt":"<RFC 3339 UTC time>","dataDiffers":<boolean>,"copy":<boolean>,"targetStarted":<boolean>,"snapshot":"<id>","health":{"disabledPlugins":[…],"namedRows":[…],"bundles":[…]}}`. `previous` is the version [C1](c01-home-layout.md)'s `previous` pointer named before the update, and the field is absent when no `previous` pointer existed. `snapshot` is the profile history version's id, present from the `waiting` phase on. `health` is what the report predicts for the health check, `bundles` absent when it predicts none. `refused: true` is added when C3's table refused the automatic rollback.

- **One rule for the record.** The successor marks the record `committed` once it runs, and the record stays for a later rollback. Every rollback rewrites it with phase `rolling-back` before the table's first step, and the record goes only once the runtime rolled back to has passed its health check. An update that ends before the switch removes it.
- **The stash.** Before an update writes its first record, a `committed` record of the previous update is moved, by one flushed rename, to `run/<profile>/update.previous.json`. It moves back when the update ends before the switch or is rolled back automatically, and it is removed when the update commits; an update that ends before the switch also discards its session-data copy.

- **A killed requester.** Killing the terminal or process that sent the request does not stop the update; the home process keeps running and finishes the update or rolls it back.
- **A killed home process.** Every pointer write is [C1](c01-home-layout.md)'s atomic rename, so `current` always names a whole, installed version. At the next start, step 3 of the start sequence reads the journal:
  - with no record and a stash, the stashed record moves back, and the start reads it as below;
  - with `refused`, the start fails with `ROLLBACK_NEEDS_DATA_COPY` and boots no Host; the person runs `delorun recover rollback --profile-only`, which keeps `to`, or `delorun recover safe-mode`;
  - with `committed`, the record stays while `current` names `to`, and a stash left beside it is removed with every copy but this update's; the record is removed when `current` names `from`;
  - with a phase before `switching`, or with `switching` or `health-check` and `current` naming `from`, nothing switched: the start restores `previous` to the record's `previous` (or removes `previous` when the record has none — the kill between the two pointer writes left it holding `from`), discards the update's session-data copy, removes the record, puts the stashed record back and runs `from`;
  - with `switching` or `health-check` and `current` naming `to`, the start records `targetStarted` and runs H1 to H5 on `to` against the record's `health` (H1 and H2 alone when the record has none); when it passes, it marks the record `committed` and settles the stash as for `committed`; when it fails, it applies [C3](c03-update-report.md#rollback)'s rollback table while it still holds the lock, with both pointers restored to their values before the update (`current` to `from`, and `previous` to the record's `previous`, or removed when the record has none), then releases the lock and starts again from `from` once `from` passes the check the launcher runs before a start (a `from` that fails it is logged and nothing starts); when the table refuses, the record gains `refused`;
  - with `rolling-back` and `current` naming `to`, the start completes the rollback through the table before any Host boots, with `current` set to `from` and `previous` to `to`, then releases the lock, starts again from `from` and fails with `HEALTH_CHECK_FAILED`;
  - with `rolling-back` and `current` naming `from`, the start's Host boot is the health check of `from` (H1 and H2): when it passes, the record is removed and the stashed record moves back; when it fails, the record stays and the start fails with `HEALTH_CHECK_FAILED`.
- **Installed versions.** A version installed by an interrupted update stays in the store as a non-current version until [C1](c01-home-layout.md)'s retention removes it.

## Rollback

- **CLI runtime.** `delorun recover rollback [--profile-only]`, or the studio's rollback, sends `rollback` with `profileOnly`. It reads the update record and needs a `committed` update to the running version (`NO_UPDATE_RECORD` otherwise), runs the `reporting`, `waiting`, `switching` and `health-check` phases with the record's `from` as the target, installs nothing, and in `switching` applies [C3](c03-update-report.md#rollback)'s rollback table after the Host has stopped. The table runs its preflight, then the record is rewritten with phase `rolling-back`, then the data, the profile snapshot and the runtime go back in that order. A refusal by the preflight, `ROLLBACK_NEEDS_DATA_COPY` or `ROLLBACK_TARGET_UNUSABLE`, leaves everything as it was and the Host runs again. Any later failure ends the rollback `failed`: this Host does not run again, the home process stops, and the next start completes the rollback. With `profileOnly` only the profile snapshot is restored, the record stays `committed` until this Host runs again, and is then removed. Otherwise the version rolled back to starts as the successor; once its health check passes and it has taken over, it removes the record. When it fails its health check, the pointers stay on the version rolled back to, the rollback ends `failed` with `HEALTH_CHECK_FAILED`, and the home process stops. After it commits, `current` names the version rolled back to and `previous` names the version rolled back from. With no home process running, `delorun recover rollback` takes the home lock, registers under C1's `run/data-users/` as an exclusive user until it ends, refuses with the processes named while any other user is registered, another profile's home process included, then completes an interrupted restore of a copy and applies the same table with the pointers switched from the record's `to` to its `from`; a home process that starts while it runs finds the exclusive user and refuses. With `--profile-only` it registers nothing, restores only the profile snapshot, and leaves an interrupted restore of a copy to the next start.
- **Automatic rollback.** A failed health check during an update, or at the start after an interrupted update, applies the same table and restores the pointers as the handshake states. Its record stays `rolling-back` until `from` has booted again.
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
| `delorun stop --now` wait for the final line | 60 seconds |
| `delorun stop --now` wait after `SIGTERM`, before `SIGKILL` | 30 seconds |
| `delorun stop --now` wait after `SIGKILL` | 5 seconds |
| Teardown of a failed start's Host | 5 seconds |
| Successor `ready` and health check | 120 seconds |
| Login item restarts | at most 3 within 300 seconds |
| Concurrent updates or rollbacks per profile | 1 |
| Protocol version `v` | 1 |

## Errors

| Code | Meaning |
| --- | --- |
| `UNAUTHENTICATED` | The request's token is missing, malformed, wrong or from a previous start, or `studio.open-token` carries the Host's channel token |
| `SCHEMA_VIOLATION` | The request has an unknown `op`, an unknown field or a field of the wrong type |
| `REQUEST_TIMEOUT` | No request line arrived within 5 seconds |
| `REQUEST_TOO_LARGE` | The request line exceeds 16,384 bytes |
| `BUSY` | 8 connections are already open |
| `UPDATE_IN_PROGRESS` | An update or rollback already runs |
| `REPORT_EXPIRED` | `update.apply` named a report that is unknown or older than 600 seconds |
| `UPDATE_PENDING` | A new turn was refused because an update is waiting for running chats |
| `CHATS_RUNNING` | `abort-if-busy` found running chats, or another profile's home process or another user of the chat data is registered ([other profiles](#the-home-process)) |
| `DRAIN_TIMEOUT` | Running chats did not reach zero within `drainTimeoutS` |
| `HEALTH_CHECK_FAILED` | The successor failed its health check or did not report `ready` within 120 seconds |
| `VERIFY_FAILED` | The target's metadata, log entry or files could not be fetched or failed [C1](c01-home-layout.md)'s, [C2](c02-release-manifest.md)'s or [C18](c18-release-log.md)'s checks; the line's `detail` is the launcher's refusal of the same failure, with its remedies |
| `CHANNEL_UNREACHABLE` | A download of `update.prepare` did not finish: the connection failed, stalled or was answered with a status other than 200; nothing was installed, and the line's `detail` is the launcher's refusal of the same failure |
| `GIT_UNAVAILABLE` | Git, which saves and restores the profile history, cannot run; `update.prepare` and every rollback refuse with it before any step, so a rollback never stops half-way for it |
| `NO_PREVIOUS` | A rollback was requested and no `previous` pointer exists |
| `NO_UPDATE_RECORD` | A rollback was requested and no committed update to the running version is recorded |
| `DATA_COPY_NO_SPACE` | The session-data copy the person chose does not fit on the home's filesystem ([C3](c03-update-report.md#data-formats)) |
| `ROLLBACK_NEEDS_DATA_COPY` | The data differs, the target started and no copy exists, so [C3](c03-update-report.md#rollback)'s table refuses the rollback; at a start, the record says the table refused the automatic rollback |
| `ROLLBACK_TARGET_UNUSABLE` | The version a rollback returns to is not installed or fails its start check, so the rollback is refused before any step |
| `STUDIO_UNAVAILABLE` | `studio.open-token` found no running Host, or a Host that cannot make a link for this computer; the line's `detail` says which |
| `HOST_STOP_FAILED` | The Host's teardown for a switch failed or did not finish within `drainTimeoutS`; nothing was switched and the Host runs again |
| `NO_RUNTIME_STORE` | At a start, an update record that is not `committed` exists and the process runs outside the runtime store, so it boots no Host; the person starts Delo through the launcher or runs `delorun recover` |
| `LOOPBACK_REQUIRED` | `devices.approve` or `devices.remove` carried the Host's channel token |
| `APPROVAL_FAILED` | The local approval or cancel was refused; the detail names [C5](c05-device-approval.md#errors)'s code, such as `APPROVAL_CODE_MISMATCH` |
| `APPROVALS_UNAVAILABLE` | `devices.approve` or `devices.remove` reached a profile that does not load `@delo/home-auth` |
| `REMOVAL_FAILED` | home-auth refused a `devices.remove`; the detail names its code |

## Consumers

- `delo/packages/home-process`: the home process, the update channel, the handshake, the journal and the login items.
- `delo/apps/cli`: `delorun`, `delorun start`, `open`, `stop`, `status`, `update` and `recover`, and setup's ending, which opens the studio through `studio.open-token`.
- `delo/packages/runtime-store`: the pointer writes and installs the handshake calls ([C1](c01-home-layout.md)).
- `delo/packages/logs`: the home process's operational log ([C20](c20-operational-logs.md)).
- The Host's update plugin, "Update now" and the studio's rollback, which are not built; no shipped bundle mounts an update plugin.
- The `delo-update-gate` row of `@delo/bundle-local`: the `deloTurnGate` service, which refuses new turns while the CLI's chat gate is held.
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
11. The channel gives a studio link only for `studio.open-token` with the start token, never for a request carrying the Host's channel token. Neither the response line nor the link is logged, and `delorun` prints the link only under `delorun open --print`.
12. `devices.approve` and `devices.remove` are accepted only with the token the person's own command reads from the token file; the Host's channel token, which the home process holds only in memory, is refused for both.

### Denial tests

| Test | Proves |
| --- | --- |
| `update-waits-for-chat` | An update applied while a fixture chat's turn runs stays in `waiting` and leaves `current` unchanged until the turn ends; a new turn in that time is refused with `UPDATE_PENDING`; with `abort-if-busy` the update ends `aborted` with `CHATS_RUNNING` |
| `update-channel-connect-denied` | On each dialect that enforces [C1](c01-home-layout.md)'s `home-connect`, a confined workspace command's connect to the update channel fails and it cannot read the start token |
| `update-turn-refused-while-held` | With the chat gate held, a new turn ends with `UPDATE_PENDING` before any model request, a turn that was already running takes its next step, and with the switch `update_turn_refusal` off no turn is refused |
| `the channel token cannot call devices.approve` | `devices.approve` with the Host's channel token is refused with `LOOPBACK_REQUIRED`, opens no window and approves nothing, while the same token's `status` succeeds and the person's token opens the window |
| `update-channel-token-required` | A request with no token, with a wrong token and with the previous start's token each receives `UNAUTHENTICATED` and no other field |
| `update-channel-landlock` | Under Landlock, a confined workspace command's connect to the update channel succeeds, its request fails with `UNAUTHENTICATED` because it cannot read the token, and `delorun verify` reports that state |
| `update-channel-not-enforced-reported` | On a fixture dialect that cannot enforce [C1](c01-home-layout.md)'s rules, `delorun verify` reports them as `not-enforced` |
| `update-request-fields` | A request with a path, URL or command field, or an unknown `op`, is refused with `SCHEMA_VIOLATION` and changes nothing |
| `studio-open-token-person-only` | `studio.open-token` returns a fresh link for the start token; the Host's channel token, which `status` accepts, and a missing or wrong token receive `UNAUTHENTICATED`; a request with an unknown argument or a port outside 1 to 65535 receives `SCHEMA_VIOLATION`; and neither the link nor its token reaches the home log |
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
- **The person's own processes.** A process of the person's user outside the sandbox can read the token and run `delorun update` itself. With the token it can also run `devices.approve`, which opens the approval window and approves a pending request given its match code, `devices.remove`, and `studio.open-token`, which returns a fresh studio sign-in link. A holder that also controls a device that asks to be approved approves it with nobody present. The protection against the agent doing the same rests only on its commands being unable to read the token file or connect to the socket.
- **Code in the Host.** The Host's channel token stops a request the Host sends over the channel, such as one it forwards for a studio session, from obtaining a studio link. It does not confine Host code: a Host plugin runs unconfined in the home process and can call upstream's `authenticatedUrl` itself or read the token file.

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
- **Process inspection.** The token is held only in memory and in the token file, never in a command line or the environment, which same-user processes can list on macOS and Linux. bwrap gives confined commands their own process namespace, and Landlock denies a confined command tracing a process outside its domain. The studio link that `delorun open` hands to the browser launcher is on the launcher's command line; [C4](c04-admission.md#what-this-does-not-prove) states that exposure.
