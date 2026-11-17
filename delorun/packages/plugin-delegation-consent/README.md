---
description: "The consent behind Delorun's external-agent switch, for maintainers changing when an external agent such as Claude Code or Codex may start, how long it may run, and how the person allows and revokes it."
kind: "package-bundle"
---

# @delorun/plugin-delegation-consent

English | [中文](README.zh.md)

## Summary

`@delorun/plugin-delegation-consent` provides the `delegationConsent` service, the Service Provider of the external-delegation consent seam of [`@deepseek-ai/dsh-subagent`](../../../packages/subagent/subagent). An external agent is a subagent provider without a local child session, such as Claude Code (`claude-code`) or Codex (`codex`): it runs as its own program outside Delorun's sandbox and approval prompts, can read and change files wherever its own settings allow, Delorun's home included, and uses the person's own sign-in and account. The runtime asks the service before every external start and starts the provider only on its `allow`. The plugin also gives the model's `plugin_manager` a guard against bringing such an agent in, and serves the loopback-only routes behind the studio's approval card action and its External agents section. With `enabled` off, the schema's default and the C16 switch `external_agent_consent`'s parity value, it mounts nothing and external providers start as upstream starts them.

## Contents

- [Contract](#contract)
- [Configuration](#configuration)
- [Surfaces](#surfaces)
- [Known limitations](#known-limitations)
- [Tests](#tests)

## Contract

- **Review order.** `review` decides each external start in this order: a chat whose sandbox policy resolves to `read-only` is refused whatever was granted, and every chat is refused while no sandbox policy is composed; a chat without a workspace folder is refused, and so is a run directory outside the chat's workspace; a grants file that cannot be read refuses, so no grant counts; a grant for the provider in the chat's workspace allows; a start whose top-level chat is in Full access, with its own logged approval policy `never` and sandbox mode `danger-full-access` together, allows without anyone being asked while `fullAccessStartsAgents` is on (the check walks up a local subagent's `parentSession` headers to that chat and never reads the child's own policy, which is pinned to `never`, or its inherited sandbox; an ancestor it cannot find counts as not Full access); otherwise the person is asked through the composed `approval` service. Without an approval service the start is refused.
- **The ask.** The approval carries the `external-agent` grant marker, the provider as its tool name and the text of [`askText`](src/copy.ts) in English and Chinese: what runs, the folder it runs in (the workspace, or a folder inside it named with its workspace), what it can reach, whose account pays, and how to allow it for the workspace or revoke that. `@delorun/home-auth` refuses an answer to an `external-agent` ask from a reach device, so only the studio on the home's own computer can answer it. Only `allowed-once` allows, and it records nothing: the next start asks again.
- **Refusals.** Every refusal is a sentence the model reads through the subagent runtime's `DELEGATION_CONSENT_REFUSED` error, naming why and what the person can do. A chat whose approval policy is `never` has every ask rejected by the approval service without anyone being asked. In a Full access chat (`never` with `danger-full-access`) the agent starts anyway while `fullAccessStartsAgents` is on; with it off, or in a `never` chat on another sandbox mode, the agent starts only with a workspace grant, and the refusal names the workspace allowance in Settings and the switch. An Auto chat's policy is `ask`, so the person is asked there as in any other chat.
- **Run time limit.** Every allowed start carries `runTimeoutMinutes`; the runtime stops the run at the limit and reports it as an error result.
- **Tool description.** `describe` replaces the delegation tool's opening sentences for an external provider with [`describeAgent`](src/copy.ts): use it only when asked or clearly useful, it runs outside the sandbox on the person's account, every run waits for the person's approval at their computer unless the agent is allowed for the workspace, a full-access chat starts it without asking unless the person turned `fullAccessStartsAgents` off, and where no one can be asked it is refused unless it is allowed for the workspace.
- **Turning it off.** Only the person at the home's own computer turns `enabled` off: in Settings, External agents, or by editing the profile there. Whatever `enabled` is, the plugin registers it in `apply()` with `@delorun/home-auth` as a switch only the computer turns off (`EXTERNAL_AGENT_CONSENT_SWITCH`), so remote access refuses a reach device's settings write that could turn it off, unlocked or not, with `loopback-required: turning the external-agent consent off`; an unlocked device's run time limit and turning it on stay ordinary settings writes. The plugin also registers `fullAccessStartsAgents` (`FULL_ACCESS_STARTS_AGENTS_SWITCH`) with `safeValue: false`, so a reach device may write `false` but a write that could turn it on is refused, unlocked or not, with `loopback-required: turning external agents starting without asking in Full access chats on`. Remote access also refuses a device every slash command its list does not name and every `setPluginEnabled` on a protected row. The row is on `@delorun/bundle-local`'s `protectedPlugins`, so the model's `plugin_manager` cannot disable or reconfigure it, or undo or restore to a version that does, and no other model tool writes settings; setup's prompts answer does not write it. A full-access chat can still edit the profile's files with a command.
- **Grants.** A grant is one workspace key and one provider name in `secrets/delegation-consent/grants.json` under the Delorun home (contract C1's protected state), version 1, parsed strictly and changed under the permission-defaults store lock. The service reads the file at every start, so `delorun workspace external-agents` and the studio change the next start without a restart. `allowWorkspace` records a grant only with `confirmed`, for an external provider this studio registers, in an open chat whose folder Delorun adds as a workspace; `revoke` removes one.
- **Plugin management.** The tool guard ([`src/guard.ts`](src/guard.ts)) refuses a `plugin_manager` call that installs or enables a bundle of an external-agent package, or enables or configures a Loader row whose module belongs to one. An external-agent package is any `@deepseek-ai/dsh-subagent-*` or `@deepseek-ai/dsh-experimental-subagent-*` package except the two in-process ones (`fork-in-process`, `spawn-in-process`), whose providers run a child session in this process: Claude Code, Codex, the DSH SDK child and ACP, whose `command` runs any program, among them. A target is read as plugin management reads it (`specPackageName` of `@deepseek-ai/dsh-plugin-manager`, with the profile's saved dependencies), case-folded and trimmed, through an npm alias (`x@npm:…`, `npm:…`), and for a local path through its manifest and its last package segments. Disabling and removing pass. The person adds those agents from the Plugins page or the first-run setup, which do not run through the model's tool.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | false | Mounts the service, the guard and the routes; the C16 switch `external_agent_consent`. `@delorun/bundle-local` turns it on; the person turns it off in Settings, External agents, which a reach device cannot write, and setup's prompts answer leaves it alone. |
| `runTimeoutMinutes` | 30 | How long one external run may take, 1 to 1440 minutes; Settings, External agents changes it, from the next run. |

The fields are a schemastery `Config`, so upstream's settings service describes and writes them; a change applies without a restart ([fields](src/wire.ts)).

`fullAccessStartsAgents` (default true) sets whether a start from a top-level chat in Full access (approval policy `never` and sandbox mode `danger-full-access`, or from a local subagent of one) starts an external agent without asking and without a workspace grant. Settings, External agents shows it, a reach device may only turn it off, and it is read at each review.

## Surfaces

- **Approval card.** `@delorun/bundle-local` adds "Allow for this workspace" to an `external-agent` card at the home's computer; it records the grant through `POST /api/delorunDelegationConsent.allow`, then answers the card. Once the card answered or no longer accepts an answer, the action is disabled; the card's `canAnswer` is read when a click starts, so a click then records nothing, and again before the card is answered. A phone sees "Approve this at your computer."
- **External agents.** Settings, External agents holds the switch **Ask before external agents run** and the run time limit, written to this row through upstream's settings service as live fields, so a saved change applies without restarting the row: turning `enabled` off disposes the service, guard and routes, turning it on mounts them again, and a new run time limit applies from the next run. It also lists each grant with its revoke (`GET .grants`, `POST .revoke`).
- **Terminal.** `delorun workspace external-agents [<folder> <agent> on|off]` lists, adds after a terminal confirmation, and revokes grants.

Every route answers only the home's own computer and refuses others with `LOOPBACK_REQUIRED` ([routes](src/routes.ts), [messages](src/wire.ts)); while dangerous mode holds, a device that holds an unlock is admitted too ([`@delorun/home-auth`](../home-auth/README.md#dangerous-mode)).

## Known limitations

- The service decides whether an external agent starts, not what it does: once started it acts under its own settings, outside Delorun's sandbox, until it ends or reaches the time limit.
- The review exists only while the row runs. The module exports `providesDelegationConsent` as `true`, so while an enabled row of this plugin is not running, for example after its start failed, the runtime starts no external agent (`DELEGATION_CONSENT_UNAVAILABLE`); with the switch off the row runs without the service and external agents start as upstream starts them. `delorun` also checks at start that a profile with the switch on mounts the row enabled and started, as for Delorun's other consent rows.
- The guard does not cover `plugin_manager`'s undo and restore of an earlier profile state, and a git or tarball spec the profile has not saved names its package only once installed, so the guard cannot read it; the review still asks before each start of the provider it registers. A full-access chat can run any command, `pnpm` included.
- A preset's own plugin rows, such as an agent team preset's, are outside bundle patches; external providers they register are still reviewed, because the review sits in the subagent runtime.

## Tests

[`tests/consent.spec.ts`](tests/consent.spec.ts) proves each refusal and consent against the service and a real `SubagentRuntime`: without consent no provider starts, a read-only chat and a composition without a sandbox policy are refused before any grant counts, a chat without a folder, a folder outside the workspace and an unreadable grants file refuse, the ask names a run folder inside the workspace, the real approval service with policy `never` (configured or the chat's own) starts a Full access chat without asking while `fullAccessStartsAgents` is on, refuses without asking when it is off or the sandbox mode is not `danger-full-access` unless the workspace holds a grant, and asks under `ask`, allow-once records nothing, a revoke takes effect at the next start, the guard refuses each install, enable and configure path of an external-agent package under every spelling (version, npm alias, relative and absolute path, leading space, upper case, saved git spec) and passes the in-process subagents and the rest, a disabled mount provides nothing, a saved change of any field is followed without a restart, and every route refuses a non-loopback caller. Saving both fields through upstream's Settings service is covered in `apps/cli/tests/consents/delegation-settings.integration.spec.ts`. A reach device's settings write, slash command, undo and restore are refused in `apps/cli/tests/denial/reach/reach-access.spec.ts`, and `plugin_manager`'s configure, undo and restore of the row in `packages/boot/plugin-manager/tests/delorun-protected-plugins.spec.ts`. The runtime's side, including the time limit, is covered in `packages/subagent/subagent/tests/external-consent.spec.ts`.

## When the service fails

If the consent's service fails to start while `enabled` is on, the row stays active and mounts a service that refuses every external agent start. The refusal names the row `delorun-delegation-consent` and the failure, and says to restart Delorun, read the logs or start in safe mode. With `enabled` off nothing is mounted and external agents start as stock.

The stand-in mounts only when the row loads and its service fails. A row whose plugin never loads, or whose `inject` never resolves, leaves the seam absent while the Host runs; the boot check at `delorun start` is the only cover for those cases.
