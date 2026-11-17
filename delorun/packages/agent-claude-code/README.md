---
description: "Delorun's driver for Claude Code as a live agent, for maintainers changing how Delorun opens, steers, stops and resumes the pinned Claude Code program, relays its permission questions and reads its plan limits."
kind: "package-bundle"
---

# @delorun/agent-claude-code

English | [中文](README.zh.md)

## Summary

`@delorun/agent-claude-code` is the Claude Code driver of `@delorun/external-agents`. It ships in the default install and stays dormant: it registers with the gate only while upstream's `claude-code` subagent provider is registered, which happens when the person adds the Claude Code pack. It then loads the Claude Agent SDK from that pack by a dynamic `import()`, and starts every Claude Code process through the spawn the gate hands it. Claude Code runs unmodified, under the person's own sign-in and their own Claude Code settings; the driver reads no credential and adds no credential variable. Upstream's one-shot provider, `@deepseek-ai/dsh-subagent-claude-code`, is untouched.

## Contents

- [Contract](#contract)
- [Configuration](#configuration)
- [Known limitations](#known-limitations)
- [Tests](#tests)

## Contract

- **Loading.** The driver accepts only the SDK version it was tested with, `TESTED_SDK_VERSION` in [`sdk.ts`](src/sdk.ts), which equals the version upstream's package pins; `open` and `probe` refuse any other with `ClaudeCodeDriverError` code `sdk-version`. Only [`sdk.ts`](src/sdk.ts) loads the SDK as a value; every other file names it in `import type` only.
- **Sessions.** `open` starts a streaming-input query; the program process starts with the first input. A new session gets a fresh program session id; `resume` continues Claude Code's own session by id, and a session Claude Code no longer has ends the first turn `failed` with `resume-failed`. Each assistant content block becomes a `text`, `reasoning` or `tool-call` event; a program message ends (`message-end`, with its tokens) when the next message, a tool result or a permission question arrives; each tool result becomes a `tool-result`; the program's result ends the turn (`turn-end`, with the turn's tokens). The frames of Claude Code's own sub-agents stay inside the tool call that started them.
- **Input.** `send(text, 'start')` begins a turn and is refused while one runs (`turn-running`). `send(text, 'steer')` joins the running turn with priority `next`, so Claude Code takes it at its next tool boundary inside the same turn; it is refused when no turn runs (`no-turn`). When a steer arrives as a turn ends and Claude Code runs a further turn for it, the seat still sees one turn, with both turns' tokens.
- **Stop.** `interrupt()` ends the running turn `interrupted` and leaves the process usable. `close()` ends the process; Claude Code keeps the session for a later resume. The open request's signal closes the session.
- **Failures.** A turn that fails carries one of the contract's categories: `signed-out` from Claude Code's authentication error or upstream's sign-in failure text, `limit` from its rate-limit error with the reset time of the last rejected rate-limit event, `model-not-offered` with the models Claude Code offers, `resume-failed`, or `program` with at most 500 characters of Claude Code's own words for the person's view.
- **Questions.** Claude Code's permission question becomes the seat's approval request, after the driver ends the open program message so the seat records the call first. The reason is Claude Code's own question sentence or the exact call, never the program model's description of the call. Allow once allows the call; reject denies it and the turn goes on; cancel, or a seat that cannot answer, denies it and ends the turn `interrupted`. A question Claude Code withdraws aborts the request's signal.
- **Allow for this run.** It is offered only when Claude Code suggests `addRules` allow entries for the call; the run rule holds exactly those rules, re-scoped to `session`, and its summary is their text in Claude Code's rule syntax. A suggested mode change (`setMode`) or folder grant (`addDirectories`) is never forwarded. Rules the seat passes back on `open` are applied as `allowedTools` for that process, which holds them as long as the process lives.
- **Process.** On POSIX the program starts under [`watcher.mjs`](src/watcher.mjs), which relays the Host's pipe to the program and, when that pipe closes, sends SIGTERM to the program's process group and SIGKILL five seconds later; the subprocess owner's own signals reach the program directly, because it stays in the watcher's group. On Windows the program starts directly: the subprocess owner's kill-on-close Job ends its tree. The process gets the subprocess owner's scrubbed environment plus the SDK's own, with `MCP_TOOL_TIMEOUT` set from the configuration. Its standard error is drained and never logged.
- **Limits.** `probe` starts Claude Code with no message, no task and `settingSources: []`, reads `accountInfo()` and the SDK's experimental usage call, and closes the process. Rate-limit events during runs reach `onLimits`. Both report the plan name, each window's percentage, reset time and status, and the sign-in state; the email, organisation and token sources are dropped. When the usage call fails the check reports the sign-in state and no windows.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `harnessToolTimeoutSeconds` | 900 | How long Claude Code waits for one harness tool call before it gives up, set as `MCP_TOOL_TIMEOUT`. |

## Known limitations

- Harness tools over MCP are not offered yet: an open request that carries them is refused with `harness-tools`.
- Claude Code's suggested rules are often prefix rules such as `Bash(echo run *)`, and a command with an output redirect is asked about again even after its rule is allowed.
- On macOS and on Linux without user systemd, a watcher killed outright together with the Host leaves the program to the gate's reaping at the next start.

## Tests

- Unit specs drive a fake SDK module and start no process: `nice -n 10 node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/agent-claude-code --maxWorkers=4`.
- [`watcher.integration.spec.ts`](tests/watcher.integration.spec.ts) proves the watcher ends a stand-in process group when its pipe closes, under the harness's subprocess owner and outside a group of its own.
- [`real-program.integration.spec.ts`](tests/real-program.integration.spec.ts) runs the pinned SDK and Claude Code against a local Messages fixture with no key: a turn, a question allowed for this run and re-applied after a resume, a rejection, an interrupt, a steer, `resume-failed` and limits checks, each leaving no process.
- Live runs under the person's own sign-in, one command each and never in a Vitest lane: `node_modules/.bin/tsx delorun/packages/agent-claude-code/live/claude.ts task|steer|interrupt|resume|questions|limits|hostkill`. Their redacted logs go under `~/delorun-rc-release/ea1-claude-logs/`.
