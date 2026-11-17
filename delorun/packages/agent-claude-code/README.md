---
description: "Delorun's driver for Claude Code as a live agent, for maintainers changing how Delorun opens, steers, stops and resumes the pinned Claude Code program, relays its permission questions and reads its plan limits."
kind: "package-bundle"
---

# @delorun/agent-claude-code

English | [中文](README.zh.md)

## Summary

`@delorun/agent-claude-code` is the Claude Code driver of `@delorun/external-agents`. It ships in the default install and stays dormant: it registers with the gate only while upstream's `claude-code` subagent provider is registered, which happens when the person adds the Claude Code pack, and withdraws when that provider leaves. At each open or limits check it finds the Claude Agent SDK in that pack through the gate's `locateClaudeSdk`, loads it by a dynamic `import()`, and starts every Claude Code process through the spawn the gate hands it. Claude Code runs unmodified, under the person's own sign-in and their own Claude Code settings; the driver reads no credential and adds no credential variable. Upstream's one-shot provider, `@deepseek-ai/dsh-subagent-claude-code`, is untouched.

## Contents

- [Contract](#contract)
- [Configuration](#configuration)
- [Known limitations](#known-limitations)
- [Tests](#tests)

## Contract

- **Loading.** The driver accepts only the SDK version it was tested with, `TESTED_SDK_VERSION` in [`sdk.ts`](src/sdk.ts), which equals the version upstream's package pins. `open` and `probe` reject a missing pack or SDK and any other version with the contract's `ProgramOpenError`, category `program`, whose detail tells the person what to do. Only [`sdk.ts`](src/sdk.ts) loads the SDK as a value; every other file names it in `import type` only.
- **Sessions.** `open` starts a streaming-input query; the program process starts with the first input. A new session gets a fresh program session id; `resume` continues Claude Code's own session by id, and a session Claude Code no longer has ends the first turn `failed` with `resume-failed`. Each assistant content block becomes a `text`, `reasoning` or `tool-call` event; a program message ends (`message-end`, with its tokens) when the next message, a tool result or a permission question arrives; each tool result becomes a `tool-result`; the program's result ends the turn (`turn-end`, with the turn's tokens). The frames of Claude Code's own sub-agents stay inside the tool call that started them.
- **Input.** `send(text, 'start')` begins a turn and is refused while one runs (`turn-running`). `send(text, 'steer')` joins the running turn with priority `next`, so Claude Code takes it at its next tool boundary inside the same turn; it is refused when no turn runs (`no-turn`). When a steer arrives as a turn ends and Claude Code runs a further turn for it, the seat still sees one turn, with both turns' tokens.
- **Stop.** `interrupt()` ends the running turn `interrupted` and leaves the process usable. `close()` ends the process; Claude Code keeps the session for a later resume. The open request's signal closes the session.
- **Failures.** A turn that fails carries one of the contract's categories: `signed-out` from Claude Code's authentication error or upstream's sign-in failure text, `limit` from its rate-limit error with the reset time of the last rejected rate-limit event, `model-not-offered` with the models Claude Code offers, `resume-failed`, or `program` with at most 500 characters of Claude Code's own words for the person's view.
- **Questions.** Claude Code's permission question becomes the seat's approval request, after the driver ends the open program message so the seat records the call first. The reason is Claude Code's own question sentence or the exact call, never the program model's description of the call. Allow once allows the call; reject denies it and the turn goes on; cancel, or a seat that cannot answer, denies it and ends the turn `interrupted`. A question Claude Code withdraws aborts the request's signal.
- **Allow for this run.** It is offered only when Claude Code suggests exactly one `addRules` allow entry, for the tool that asked, whose content equals the exact command asked about and holds no `*`. A prefix rule such as `Bash(rm:*)` or `Bash(echo run *)`, a bare tool rule, a path rule, or more than one rule gives the question no run rule, so the person sees only Reject and Allow once. The run rule holds that one rule, re-scoped to `session`, and its summary is its text in Claude Code's rule syntax. A suggested mode change (`setMode`) or folder grant (`addDirectories`) is never forwarded. Exact rules the seat passes back on `open` are applied as `allowedTools` for that process, which holds them as long as the process lives; any other rule there is dropped.
- **Process.** On POSIX the program starts under [`watcher.mjs`](src/watcher.mjs). The subprocess owner starts the watcher as the leader of a process group of its own; the watcher never detaches the program, so the program and every command it runs stay in that group and the owner's signals reach them all. When the Host's pipe closes, or the watcher receives a terminating signal, it sends SIGTERM to its group and SIGKILL five seconds later. A watcher started outside a group of its own refuses to start the program (exit 126) rather than signal its starter's group. When the watcher exits, the driver asks the subprocess owner to end whatever is left in its managed range, so a watcher killed outright leaves nothing while the Host lives. On Windows the program starts directly: the subprocess owner's kill-on-close Job ends its tree. The process gets the subprocess owner's scrubbed environment plus the SDK's own, with `MCP_TOOL_TIMEOUT` set from the configuration; `NODE_OPTIONS` and every `DELORUN_*` name are removed. Its standard error is drained and never logged.
- **Claude Code's own state.** A seat run and a limits check leave the person's Claude Code settings files unchanged and record no trust or rule for the run folder; Claude Code writes only its startup bookkeeping, a backup of it, and the session history it resumes from.
- **Harness tools.** The gate's harness tools are offered on an in-process MCP server with a random name per session, `delorun_` and 12 hexadecimal digits. Each tool's JSON Schema must describe an object and its name must use only letters, digits, `_` and `-`, or `open` fails. The driver answers Claude Code's permission question itself only for `mcp__<that server>__<an offered tool>`; every other question, including the same tool name on another server, goes to the seat. A call's abort signal fires when Claude Code gives up at `MCP_TOOL_TIMEOUT` or the session closes, and the program then reads that the call stopped.
- **Limits.** `probe` starts Claude Code with no message, no task and `settingSources: []`, reads `accountInfo()` and the SDK's experimental usage call, and closes the process. Rate-limit events during runs reach `onLimits`. Both report the plan name, each window's percentage, reset time and status, and the sign-in state; the email, organisation and token sources are dropped. When the usage call fails the check reports the sign-in state and no windows.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `harnessToolTimeoutSeconds` | 900 | How long Claude Code waits for one harness tool call before it gives up, set as `MCP_TOOL_TIMEOUT`. |

## Known limitations

- Claude Code often suggests a prefix rule, for example for a command with an output redirect, so many questions offer no run rule.
- A watcher killed outright together with the Host leaves the program to the gate's reaping at the next start.
- The watcher's five seconds between SIGTERM and SIGKILL are fixed.

## Tests

- Unit specs drive a fake SDK module, with the real SDK's in-process MCP server for harness tools, and start no process: `nice -n 10 node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/agent-claude-code --maxWorkers=4`.
- [`watcher.integration.spec.ts`](tests/watcher.integration.spec.ts) proves, with stand-in processes under the harness's subprocess owner, that closing the pipe ends the group, that a program ignoring SIGTERM is gone after `terminate()`, that killing the watcher outright leaves no program, and that a watcher outside a group of its own starts nothing.
- [`real-program.integration.spec.ts`](tests/real-program.integration.spec.ts) runs the pinned SDK and Claude Code against a local Messages fixture with no key: a turn, a question allowed for this run and re-applied after a resume, a rejection, an interrupt, a steer, `resume-failed`, limits checks, a harness tool call and one cut off at the wait limit, and the person's settings left byte-identical, each leaving no process.
- Live runs under the person's own sign-in, one command each and never in a Vitest lane: `node_modules/.bin/tsx delorun/packages/agent-claude-code/live/claude.ts task|steer|interrupt|resume|questions|limits|hostkill`. Their redacted logs go under `~/delorun-rc-release/ea1-claude-logs/`.
