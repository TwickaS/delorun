---
description: "Delorun's live external agents, for maintainers: Claude Code and Codex as child chats of the chat that handed work over, behind the externalAgents.liveAgents preview flag."
kind: "package-library"
---

# @delorun/plugin-agent-seats

English | [中文](README.zh.md)

## Summary

This package makes Claude Code and Codex live agents: a child chat (a seat) of the chat that handed work over, whose model is the external program and which a person can watch, message and stop. Everything except the declaration of the preview flag `externalAgents.liveAgents` registers only while that flag is on. With the flag off, a chat's tools, model routes, presets and routes are as without this package, and upstream's one-shot `subagent_claude_code` and `subagent_codex` tools stay as they are. The start gate (`@delorun/external-agents`) is the only code that starts either program; this package asks it.

## Contents

- [Configuration](#configuration)
- [Contract](#contract)
- [Questions from the program](#questions-from-the-program)
- [Tests](#tests)

## Configuration

The Host row `delorun-agent-seats` holds `seats`, a list of `{ provider, route, preset, toolName, maxDepth, contextWindow }`. The default has one seat each for Claude Code (`claude_code`) and Codex (`codex`).

| Field | Meaning |
| --- | --- |
| `provider` | The agent the gate runs: `claude-code` or `codex`. Any other value stops the row. |
| `route` | The hidden model route the seat child's turns use. |
| `preset` | The agent preset that composes the seat child. |
| `toolName` | The hand-off tool the lead's model sees; its dotted form (`claude_code.`) prefixes the seat's recorded tool names. |
| `maxDepth` | The deepest chain of seat children that may hand work on; 1 means a seat child cannot hand over again. |
| `contextWindow` | The program's context window in tokens, which the token meter divides by. |

Two seats may not share a provider, route or tool name. The row reads the preview flag once when it loads, so a change of the flag takes a reload of the row. It needs the services `previewFlags`, `llm`, `sessions`, `sessionProjections`, `externalAgents`, `subagents`, `tools`, `agentPresets`, `connection` and `profileContext`; the model choices are kept in `agent-seat-models.json` in the profile folder.

## Contract

- **Flag off.** The row declares the flag and registers nothing else.
- **Flag on.** For each seat the row registers a subagent provider named `<provider>-seat`, the hand-off tool, a model route, the preset and the `agentSeat` session projection. It provides the `seatPrograms` service and two Host routes. Every registration is an effect, so stopping the row withdraws all of them.
- **Hand-off.** The tool starts a continuable child of the lead on the seat provider, route and preset, with the task exactly as written. The gate's refusals reach the model as fixed sentences. In a chat with the live agent, upstream's one-shot tool for the same agent is hidden from that agent with `ctx.tools.restrict`.
- **Model route.** `listModels()` is empty, so no picker shows the route, and the adapter refuses every request that is not a seat child's own turn. Each harness step streams one program message.
- **Records.** The preset mounts the seat tool executor, which writes the program's tool calls as records named with the seat's prefix (`claude_code.Bash`), so the native executor can never run one. Program output is cut at a fixed cap and the full text kept as a spill.
- **Host routes.** `POST /api/agentSeat.resume` starts a new turn once a reached plan limit has lifted, and `POST /api/agentSeat.chooseModel` keeps the person's pick of a model the plan offers, once per workspace. Nothing resumes by itself. Both routes are open to the computer and, with no prompt, to any approved phone once the home is mounted (class `free`): Resume only flips the seat's status, and the model pick changes no permission.
- **Lease end.** When the consent ends a seat's lease (chat archived, permission revoked, consent off), the gate stops the program, this row drops its run and the chat shows why its agent stopped.
- **Not read yet.** The check that tells a person the program's own session moved on while the chat was closed runs only when the entry supplies a `tail` reader, and the chat's program version and settings name only when it supplies `info`. Neither is supplied.
- **Relay seam.** `mountSeats(ctx, config, { relay })` takes the question relay as a function of the mounted state and the exact seat provider names. Without one, every question of a program is rejected.

## Questions from the program

A seat's permission questions go to the person through the approval service on the seat child, with the `external-agent` grant marker: the computer may allow, and a phone may allow only with an answer grant for exactly that question and that answer (a grant for `allowed-once` never admits `allowed-for-run`, and the reverse); no PIN or code unlock, approval grace or dangerous mode stands in for it, and any phone may reject. The studio's card shows the granting answers on the computer and on an approved phone, where each one first asks for Face ID, or the PIN keypad on a phone with no passkey, through the reach service's `confirm`, which mints that grant; a question without a call id cannot be confirmed, and the card says Not confirmed. A page with no reach service offers Reject only. In a Full access chat the questions are allowed without a card and logged as allowed. "Allow for this run" reaches the host as the raw answer `allowed-for-run`, which a listener on `approval/request` turns into allowed-once plus a mark; the gate keeps the program's rule in memory until the seat's lease ends. Once the consent service holds the rule, the seat child's log gets an `external-agent/run-allowed` event naming the question's `approval/asked` event; when the gate falls back to Allow once, nothing is logged.

A question waits until the seat has written the record of its call, so the log reads call, asked, decided, result. The relay asks only when that record carries the name the seat gives the call (`claude_code.Bash`); otherwise it rejects the question and logs a warning. The card shows the program's reason as the agent's words ("Claude Code says: ..."). A stop ends a pending question before the turn ends.

## Tests

- [`tests/wiring.spec.ts`](tests/wiring.spec.ts) proves that the entry registers nothing but the flag while it is off, registers the tools, providers, routes, presets and Host routes while it is on, withdraws them when the row stops, and tells a seat's chat why its lease ended.
- [`tests/provider/provider.spec.ts`](tests/provider/provider.spec.ts) proves the subagent provider, the hand-off tools, the depth rule and every gate refusal on a real subagent runtime and tool pipeline.
- [`tests/adapter`](tests/adapter) proves the model route on a scripted gate and program, including its refusals.
- [`tests/executor`](tests/executor) proves the seat executor, the preset and the output cap on the production agent loop.
- [`tests/state`](tests/state) proves the `agentSeat` projection, the model choices, the Host routes and the seat's turns on a real session store.
