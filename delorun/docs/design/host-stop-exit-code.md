---
description: "Design of the exit code of a Host stop: a stop whose Host teardown fails or overruns ends the home process with a failure code and a log line, instead of the success code a normal stop gives."
---

# The exit code of a failed Host stop

English

## Summary

When the home process stops, it closes its Host through upstream's bounded shutdown with the success code. That shutdown ends the process with the code it was given whether the teardown finished, failed or overran, so a stop whose Host did not tear down cleanly ends with exit code 0 and leaves no line in the home log. A supervisor, `delorun stop` and the person all read it as a clean stop. This design makes a failed or overrunning teardown end the process with a failure code and records why.

## Contents

- [What exists today](#what-exists-today)
- [The rules](#the-rules)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Denial tests](#denial-tests)
- [What is built so far](#what-is-built-so-far)

## What exists today

- `RunningHost.close()` in `delorun/apps/cli/src/start.ts` calls `booted.shutdown(EXIT.ok)`, then removes the sandbox overlay.
- `booted.shutdown` is upstream's `createProcessShutdown` (`apps/cli/src/process-shutdown.ts`). It disposes the Host and arms a `PROCESS_SHUTDOWN_TIMEOUT_MS` (5 seconds) timer. When the disposal rejects, or the timer fires first, it calls `process.exit` with the code it was given, which is `EXIT.ok`. Neither case is logged.
- The home process's `shutdown(code)` in `delorun/packages/home-process/src/home-process.ts` calls `closeHost()` first and logs a rejected close as "the Host did not close". Upstream's forced exit ends the process before that line, before the update channel closes and before the home process's own `exit(code)` runs, so the code the stop asked for, such as 130 for an interrupt, is lost as well. The home lock is released by the process's exit handler.
- The sandbox overlay stays when the process is forced to exit, which is safe: the next start rewrites it.
- An update's or a rollback's switch stops the Host differently: `suspend()` disposes it without ending the process, and the home process bounds that wait itself and reports a Host that did not stop as `HostNotStoppedError`.

## The rules

1. `close()` disposes the Host through the profile's own teardown, as `suspend()` does, bounded by the home process with the same limit that bounds a switch, and does not call upstream's process shutdown.
2. A teardown that rejects or overruns is logged as "the Host did not stop" with its reason, and the home process ends with `EXIT.failed` instead of the code the stop asked for. The overlay stays.
3. A teardown that finishes in time ends the process with the code the stop asked for, as today.
4. If rule 1 cannot hold because the bounded shutdown must stay the one exit path, upstream's `createProcessShutdown` takes a second code for a disposal that rejects or overruns, and Delorun passes `EXIT.failed`. That change is upstream and is recorded in Delorun's upstream ledger.

## What this does not protect against

- **A Host that never returns from teardown.** The bound ends the process; child processes the Host started and did not stop are not stopped by this design.
- **A process killed from outside.** `SIGKILL` and a computer that loses power end the process without any code this design sets.

## Denial tests

- `a stop whose Host teardown rejects ends with the failure code and logs it`
- `a stop whose Host teardown overruns its limit ends with the failure code`
- `an interrupted stop whose teardown fails ends with the failure code, not 130`
- `a clean stop ends with the code it asked for`

## What is built so far

Nothing; the normal stop path is as described under "What exists today".
