---
description: "Delorun's headless bundle, for maintainers changing which guard rows delorun headless mounts over upstream's headless profile and the values the Host invariants hold them to."
kind: "package-bundle"
---

# @delorun/bundle-headless

English | [中文](README.zh.md)

## Summary

`@delorun/bundle-headless` is the bundle that gives the home's `headless` profile Delorun's guards. It holds no code; its [`cordis.patch.yml`](cordis.patch.yml) turns off two privacy defaults, inserts seven guard rows and protects them from plugin management, after upstream's `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-headless` bundles. `delorun headless` links it into the profile, refuses a profile that does not load it, and holds its rows to [C19](../../docs/contracts/c19-home-process.md#host-invariants)'s Host invariants before and after boot.

## Contents

- [Use this bundle](#use-this-bundle)
- [Rows](#rows)
- [Refusals](#refusals)
- [Parity composition](#parity-composition)
- [Tests](#tests)

## Use this bundle

- **Linking.** The first `delorun headless` run creates the `headless` profile from upstream's template and links this bundle into it as the one-time change `headless-bundle`, which `profiles/headless/delorun-migrations.json` records ([C1](../../docs/contracts/c01-home-layout.md#profiles)). The same run brings the bundle to a profile an earlier release created.
- **Layer order.** The bundle applies after upstream's bundles and before the profile's own `cordis.patch.yml`.
- **A removed bundle.** `delorun headless` stops before boot when the profile does not load the bundle, and names the remedy: remove `profiles/headless/delorun-migrations.json` so the next run links the bundle again, or remove the `profiles/headless` folder so Delorun creates the profile again.
- **No setup answer.** A headless profile has no setup answer, so each row has Delorun's default value (`HEADLESS_ROW_VALUES` in [`compose.ts`](../../apps/cli/src/compose.ts)) and the Host invariants refuse any other value.

## Rows

| Row | Plugin | What it does in a headless task |
| --- | --- | --- |
| `session-log-deepseek` | upstream's session-log upload | `enabled: false`: DeepSeek's session-log upload is off ([C11](../../docs/contracts/c11-setup-answers.md)) |
| `session-telemetry-otel` | upstream's feedback telemetry exporter | `disabled: true` |
| `delorun-instruction-consent` | [`@delorun/plugin-instruction-consent`](../plugin-instruction-consent/README.md), with `approvedPluginWrites` | A model-authored write to a skill, a preset or an `AGENTS.md`, and the agent's first write in a chat to the folder of a plugin approved under Changes, asks for consent, which no one answers, so it is refused |
| `delorun-mcp-consent` | [`@delorun/plugin-mcp-consent`](../plugin-mcp-consent/README.md) | A new stdio MCP server that a person's own patch adds is not started until its command is accepted |
| `delorun-schedule-consent` | [`@delorun/plugin-schedule-consent`](../plugin-schedule-consent/README.md) | A scheduled follow-up that a person's own patch makes possible asks for consent, which no one answers, so it is refused |
| `delorun-permission-defaults` | [`@delorun/plugin-permission-defaults`](../plugin-permission-defaults/README.md) | A switch to full access for a workspace without a recorded grant is refused |
| `delorun-fetch-guard` | [`@delorun/plugin-fetch-guard`](../plugin-fetch-guard/README.md) | A fetch of a private, loopback or link-local address is refused |
| `delorun-tool-failure-guard` | [`@delorun/plugin-tool-failure-guard`](../plugin-tool-failure-guard/README.md), with `stderrNotice` | A turn whose tool calls keep failing (6 in a row, or 8 of the last 12) stops before its next model request, and one line on standard error says why |
| `delorun-plugin-changes` | [`@delorun/plugin-changes`](../plugin-changes/README.md) | An agent's `plugin_manager` install or removal does not run; it is recorded in the profile's change log as a change waiting for the person's review at their computer ([C21](../../docs/contracts/c21-changes.md#the-agent-and-plugins)); the profile serves no studio, so the plugin registers no Changes route |
| `delorun-update-gate` | `@delorun/bundle-local/update-gate`, with `holdUntilChecked` | The first step of every turn waits until `delorun headless` has checked the booted Host's rows and services; no update or stop waits on a headless run's chats; a turn that waits longer than `checkWaitSeconds` (60 by default) ends with `START_CHECK_PENDING` instead of waiting without a message |
| `plugin-manager` | upstream's plugin management, `protectedPlugins` | The guard rows above and the sandbox rows cannot be disabled, reconfigured or removed through the `plugin_manager` tool, which full access runs without a prompt, as in [`@delorun/bundle-local`](../bundle-local/README.md) |

## Refusals

- **Guards that ask a person.** The profile composes no approval answerer, so an ask resolves `unavailable` and the guard refuses the action with its reason.
- **Full access before boot.** `--permission-mode danger-full-access` and `DSH_PERMISSION_MODE=danger-full-access` are refused for a working directory without a full-access grant, which the person records at the home's computer with `delorun workspace full-access <folder> on` or in the studio, and when the record of grants cannot be read; no task starts.
- **The turn gate.** The task's first step waits for the post-boot check. A Host the check refuses is stopped with the task.

## Parity composition

No profile the recorded-session replay runs mounts this bundle: the [parity composition](../../docs/contracts/c16-parity-composition.md) keeps upstream's `headless` profile as it is. `instruction_layer_consent`, `permission_defaults`, `fetch_guard`, `tool_failure_guard` and `update_turn_refusal` are registered by the plugins and by `@delorun/bundle-local`, and the parity checks read only `@delorun/bundle-local`'s and `@delorun/bundle-studio`'s patches, so this bundle adds no switch and no entry to the registry.

## Tests

- `delorun/apps/cli/tests/compose.spec.ts` composes the `headless` profile with and without this bundle and holds its rows to `HEADLESS_ROW_VALUES` before and after boot.
- `delorun/apps/cli/tests/headless.spec.ts` covers the full-access refusal before boot and the turn-gate release.
- `delorun/apps/cli/tests/headless-bundle.spec.ts` covers the linking of the bundle as the one-time change `headless-bundle`.
- `delorun/apps/cli/tests/headless-guards.integration.spec.ts` boots the profile with the bundle and checks that each guard refuses in a headless run.
