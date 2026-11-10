---
description: "Delo's per-workspace permission defaults, for maintainers changing which preset a new workspace starts on, when full access is asked for, and which mode switch the guard refuses."
---

# @delo/plugin-permission-defaults

English | [中文](README.zh.md)

## Summary

Upstream composes one permission for the whole deployment: every new chat starts on the same preset, and choosing `danger-full-access` takes effect at once. This plugin makes the preset a property of the workspace instead. A new chat starts on the preset the person chose for its folder — `workspace-write` for a workspace nobody has chosen for — whatever the deployment default is, and full access happens only after one consent for that workspace. No surface calls `select()`, so no consent can be recorded and the guard refuses a switch to full access in every workspace. The consent is written to the home's protected state, so it covers that folder until the person chooses another preset there; explicitly choosing the safer preset withdraws it, so returning to full access asks again.

The guard that refuses an unconseted full-access switch runs before the session records anything. A refused switch therefore appends no `sandbox/mode` event and no preset identity, the session keeps resolving the mode it had, and a command started in the same synchronous step runs inside the sandbox. The guard covers the whole selection, not only a mode change: a preset that keeps the mode and drops the approval policy is refused too, so the approval prompts are not a way around the consent. A per-call `sandbox_permissions` escalation is not a mode switch: it goes through upstream's per-call approval, which this guard does not see. The refusal's words name the workspace and say what to do, so the model reads them rather than a stack trace.

Everything sits behind the switch `permission_defaults`, off by default; `@delo/bundle-local` turns it on in the CLI profile that `delorun` starts, and `delorun headless` and the desktop app run upstream's profiles without it. Off, the plugin mounts nothing: the deployment default reaches every new chat exactly as upstream seeds it, and every mode switch is recorded, which is what the parity composition asserts.

## Which preset applies

Three tiers decide a chat's permission, strongest first:

1. The chat's own log. A preset identity or a knob event the chat already holds outranks its workspace's default, so a resumed, forked or seeded chat keeps the permission it recorded. An explicit `sandbox/mode` switch also outranks the preset identity — another surface's control, an approved escalation or a delegation seed — and the chat then reports `custom` while its knobs match no configured preset; `select()` re-asserts the chosen preset when the person picks again.
2. The workspace's default. `select()` records it, and this plugin seeds it into new chats only: the seed runs on a chat that holds no permission choice yet and was never seeded.
3. The deployment default. `sandbox-policy`'s mode and the approval policy's default sit beneath both: they apply to a chat whose workspace has no entry, and to any knob a chat never overrode.

## What it provides

- `permissionDefaults` — the service behind the switch. `defaultPreset(cwd)` and `granted(cwd)` read a workspace's recorded preset and whether it holds a full-access grant, `select(agent, preset)` is the one write path a surface uses to choose a workspace's preset, and `review(session, mode)` is the guard's verdict. The entries are read once at mount and kept in memory, so the guard answers without a filesystem call; `storeProblem` names a store that could not be read.
- `sandboxModeGuard` — the mode-switch hook of `@deepseek-ai/dsh-sandbox-policy`'s session-mode seam, mounted so `setSandboxMode` refuses a switch to full access in a workspace nobody consented to. It is the seam's one provider, so a composition turns on this consent or another plugin's guard, never both.
- The store — [`src/store.ts`](src/store.ts) holds the format and the file handling: one entry per workspace, keyed by the workspace's canonical path ([`src/workspace.ts`](src/workspace.ts)), in the home's `secrets/` directory at mode 0600, so a confined command can neither read the consents nor grant itself one; on Windows, where the runner does not confine reads, it cannot write them but can read them. A store that is a symbolic link, is laxer than 0600, or holds another format is refused, and no consent counts until the person fixes it.
- `select()` asks through the composed approval service, naming the folder and what full access drops, and refuses with `FullAccessConsentRefusedError` on every answer but a grant: nothing is recorded and the workspace keeps the safer preset. Choosing the safer preset withdraws the workspace's grant, so a later full-access selection asks again.

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `false` | Delo's C16 switch `permission_defaults`, off in the parity composition; on, the plugin seeds each new chat from its workspace and mounts the guard that refuses full access for a workspace nobody consented to. |

## Tests

`tests/store.spec.ts` covers the store's path, its format's round trip, the refusals that make a store count for nothing (a laxer mode, a symbolic link, another format), the entry lookups, and the workspace key that makes one directory one workspace. `tests/permission-defaults.spec.ts` covers the switch off, the seed a new workspace gets, the consent asked once per folder, the refusal that records nothing, the mode switch the guard refuses, and the workspace that already holds a grant.
