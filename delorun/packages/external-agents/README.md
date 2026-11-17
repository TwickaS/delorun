---
description: "The start gate of Delorun's live external agents, for maintainers changing how Claude Code or Codex is started for a seat or a limits check, what is checked before and during a run, and what ends a program."
kind: "package-bundle"
---

# @delorun/external-agents

English | [中文](README.zh.md)

## Summary

`@delorun/external-agents` provides the `externalAgents` service, the start gate of live external agents. A live agent is Claude Code or Codex running as its own program for a seat, a chat whose turns the program answers, or for a limits check of the person's plan. The gate is the only Delorun code that starts either program, apart from upstream's reviewed one-shot path and `delorun agents login`; the `gates:external-agent-spawns` check refuses any other source that loads Claude Code's SDK, names the Codex package or uses the locators of the pinned programs. The package also holds the driver contract the agent packs implement (`./contract`), the locators of the pinned programs (`./locate`), the fixed sentences of its refusals (`./copy`) and the records that stop programs a dead Host left behind (`src/reap.ts`).

## Contents

- [Contract](#contract)
- [Accounts and limits](#accounts-and-limits)
- [Configuration](#configuration)
- [Known limitations](#known-limitations)
- [Tests](#tests)

## Contract

- **Drivers.** An agent pack registers its driver with `registerDriver`; a second driver for the same agent throws, and the returned disposer ends that driver's programs. Until a driver is registered every start is refused with `not-installed`. `onDriverRegistered` tells a listener when a driver arrives.
- **Start order.** `start` checks, in this order, and refuses with a `GateRefusedError` whose `refusal` names the reason: a driver is registered; the seat child has no running program; the child, its creator and its root chat are resident agents (a seat whose chat is not open under a chat the person sees is refused); the consent is on and reviews the seat, or is turned off; a plan limit is not reached; the cap on live programs has room. Only then does it open the driver's session.
- **Consent off.** A seat starts unreviewed only when the consent row `delorun-delegation-consent` exists in the profile and its saved config has `enabled: false`. A missing row, a disabled row, a row whose service is not registered, a failed row and a consent service without `reviewSeat` each refuse. When the consent appears while unreviewed programs run, they are ended.
- **Leases.** With the consent on, `reviewSeat` grants a lease that records the root chat, the workspace, the run folder and the agent. It asks the person on the root chat's open turn, else on the seat child at a resume; a workspace grant allows with no card, and so does a root chat with Full access (approval policy `never` and sandbox `danger-full-access`) while the consent's `fullAccessStartsAgents` is present and on (absent reads as off), once the read-only, workspace and run-folder checks pass; any other `never` root is refused. `start` returns the reason in `allowedBy` (`lease`, `granted`, `asked`, `full-access` or `consent-off`) for the hand-off line. Every turn the program starts is reviewed again: a difference in any of the four values, read-only turned on, a grant revoked, the lease revoked, the consent turned off, the chat or its root archived, the workspace deleted, or, for a lease Full access allowed, the root leaving Full access or the switch turning off ends the lease, and the end of a lease ends the live program. A steer within a running turn is not reviewed again. Turning the consent off ends a running program at once, mid-turn; read-only turned on, a grant revoked or Full access left while a turn runs takes effect at the next turn's review.
- **Run rules.** "Allow for this run" is kept beside the lease, keyed by the seat child, and ends with every event that ends the lease. With the consent off there is no lease, so a question's run rule is removed and the card offers only Reject and Allow once. An allowance given from a phone whose unlock later ends lasts until the lease ends.
- **Time limit.** With the consent on, each seat turn has the consent's run time limit: at the limit the gate interrupts the turn, waits `graceMs`, ends the program if the turn still runs, and the turn ends `failed` with the failure `time-limit`. With the consent off a seat turn has no time limit, as a one-shot run has none.
- **Processes.** Every process a driver starts goes through the gate's spawn, which runs it through `ctx.subprocess` in the run folder with the program's abort signal and `graceMs`, and removes `NODE_OPTIONS`, every `DELORUN_*` variable and every credential-named entry of the driver's overlay (upstream's `SENSITIVE_ENV_PATTERN` and the scrub's ambient-authority names) from its environment on top of the subprocess owner's own scrub. A spawn after the program ended throws. Ending a program closes the driver's session, aborts the signal, terminates each process and waits up to twice `graceMs` for it to exit.
- **Limits checks.** `probe(provider, signal)` takes no folder, no child and no input: the gate makes an empty folder under the system's temporary directory, admits the check under the same cap, runs the driver's probe and removes the folder. The CLI never starts a check.
- **Limit refusal.** With `limitRefusal` on, a recorded limit whose reset time is in the future refuses a seat start, and `limitRefusal(provider)` gives the consent the sentence that refuses a one-shot run ([`limitRefusal`](src/copy.ts)). A limit whose reset time has passed never refuses.
- **Seat registry.** `seat(child)` answers whether a session is a seat the gate started, with its root and agent. A seat is recognised by this registry, never by an approval policy value.
- **Host death.** While a program runs, the gate keeps the identity of each of its processes that leads a process group in `secrets/external-agents/programs.json` under the Delorun home: on Linux the process id, the kernel start time, the boot id, the executable path and the subprocess owner's systemd scope, taken from the handle and read once the process has entered that scope and left `systemd-run` (a process that does not within `graceMs` is not recorded); on macOS the process id, the start time and the path. At the next start it stops each recorded program whose identity still matches in full and whose executable is one Delorun locates (the Node binary that runs the runner, the Codex launcher and Claude Code's watcher, Claude Code's native program, or the native Codex program), stopping the scope when there is one and otherwise the group, SIGTERM then SIGKILL after `graceMs`, and drops every record; a process id that now names another process is never signalled.
- **Stopping.** Disposing the plugin, an `agent/disposed` event for the seat child and a driver leaving each end the programs concerned.

## Accounts and limits

`ctx.agentAccounts` keeps each agent's sign-in, plan and plan-limit windows in `secrets/external-agents/accounts.json` (mode 0600). It holds only `signedIn`, `plan`, each window's `kind`, `usedPercent`, `resetsAt`, `status`, `seenAt` and `source`, the offered models, and when a check last answered, failed or was asked for; every observation is rebuilt field by field, so an email, organisation, account id or token in a program's reply never reaches the file. A file that cannot be read reads as no figures, and nothing refuses because of it. Runs report figures through the driver's `onLimits`. A limits check is the gate's `probe` and runs only on an explicit act about that agent that `probeTriggers` lists: its pack was just added (no stored entry), a sign-in finished (`delorun agents login`, or the mark it leaves for the next start), or "Check now"; a Host start alone checks nothing, and `probeMinIntervalMinutes` is a floor between checks, not a timer. A window whose reset time has passed never refuses a start. `GET /api/delorunExternalAgents.accounts` answers any approved device and never starts a check; `POST /api/delorunExternalAgents.refresh` needs the computer or an unlocked device. `delorun agents status` reads the same figures through the update channel or the file. The store mounts once the gate and the connection are present.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `maxLivePrograms` | 4 | How many programs may run at once in this home, seats and limits checks together; at least 1. |
| `graceMs` | 3000 | How long a program has to exit after it is asked to stop, in milliseconds, before it is killed; at least 100. |
| `probeMinIntervalMinutes` | 30 | The shortest time between two limits checks of one agent, in whole minutes; at least 1. |
| `probeTriggers` | `pack-added`, `signed-in`, `check-now` | The explicit acts that run a limits check with no card; an act not listed starts no check. |
| `limitRefusal` | false | The C16 switch `external_agent_limit_refusal`; `@delorun/bundle-local` turns it on. |

`@delorun/bundle-local` inserts the row `delorun-external-agents`. While the consent is on, its `plugin_manager` guard refuses a model's install, enable or configure of this package and the agent packs by name.

## Known limitations

- `maxLivePrograms` does not count one-shot runs, which upstream's subagent runtime starts.
- A limit refusal can outlast a plan upgrade until the next limits check.
- On Windows nothing is recorded for reaping; the subprocess owner's kill-on-close Job ends the programs with the Host.

## Tests

[`tests/gate.spec.ts`](tests/gate.spec.ts) proves the start order and each refusal against real agents of the agent-loop testkit and a scripted driver: the consent-off cases, a seat start without `reviewSeat`, the cap, the time limit, the run-rule relay, the spawn environment and every event that ends a program. [`tests/reap.spec.ts`](tests/reap.spec.ts) proves on a fake process table that a reused process id is never signalled. [`tests/contract.spec.ts`](tests/contract.spec.ts) proves that `probe` accepts no folder and no child, and [`tests/locate.spec.ts`](tests/locate.spec.ts) the locators against fixture packs.
