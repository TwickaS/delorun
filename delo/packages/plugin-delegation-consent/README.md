---
description: "The consent behind Delo's external-agent switch, for maintainers changing when an external agent such as Claude Code or Codex may start, how long it may run, and how the person allows and revokes it."
kind: "package-bundle"
---

# @delo/plugin-delegation-consent

## Summary

`@delo/plugin-delegation-consent` provides the `delegationConsent` service, the Service Provider of the external-delegation consent seam of [`@deepseek-ai/dsh-subagent`](../../../packages/subagent/subagent). An external agent is a subagent provider without a local child session, such as Claude Code (`claude-code`) or Codex (`codex`): it runs as its own program outside Delo's sandbox and approval prompts, can read and change files wherever its own settings allow, Delo's home included, and uses the person's own sign-in and account. The runtime asks the service before every external start and starts the provider only on its `allow`. The plugin also gives the model's `plugin_manager` a guard against bringing such an agent in, and serves the loopback-only routes behind the studio's approval card action and its Permissions section. With `enabled` off, the schema's default and the C16 switch `external_agent_consent`'s parity value, it mounts nothing and external providers start as upstream starts them.

## Contents

- [Contract](#contract)
- [Configuration](#configuration)
- [Surfaces](#surfaces)
- [Known limitations](#known-limitations)
- [Tests](#tests)

## Contract

- **Review order.** `review` decides each external start in this order: a chat whose sandbox policy resolves to `read-only` is refused whatever was granted; a run directory outside the chat's workspace is refused; a grants file that cannot be read refuses, so no grant counts; a grant for the provider in the chat's workspace allows; otherwise the person is asked through the composed `approval` service. Without an approval service the start is refused.
- **The ask.** The approval carries the `external-agent` grant marker, the provider as its tool name and the text of [`askText`](src/copy.ts) in English and Chinese: what runs, what it can reach, whose account pays, and how to allow it for the workspace or revoke that. `@delo/home-auth` refuses an answer to an `external-agent` ask from a reach device, so only the studio on the home's own computer can answer it. Only `allowed-once` allows, and it records nothing: the next start asks again.
- **Refusals.** Every refusal is a sentence the model reads through the subagent runtime's `DELEGATION_CONSENT_REFUSED` error, naming why and what the person can do. A chat in full access or Auto answers asks without a person and rejects this one, so there the agent starts only with a workspace grant.
- **Run time limit.** Every allowed start carries `runTimeoutMinutes`; the runtime stops the run at the limit and reports it as an error result.
- **Tool description.** `describe` replaces the delegation tool's opening sentences for an external provider with [`describeAgent`](src/copy.ts): use it only when asked or clearly useful, it runs outside the sandbox on the person's account, and the first run in a workspace waits for the person.
- **Grants.** A grant is one workspace key and one provider name in `secrets/delegation-consent/grants.json` under the Delo home (contract C1's protected state), version 1, parsed strictly and changed under the permission-defaults store lock. The service reads the file at every start, so `delorun workspace external-agents` and the studio change the next start without a restart. `allowWorkspace` records a grant only with `confirmed`, for an external provider this studio registers, in an open chat whose folder Delo adds as a workspace; `revoke` removes one.
- **Plugin management.** The tool guard refuses a `plugin_manager` call that installs or enables a bundle of a `modelRefusedPackages` package, or enables or configures a Loader row whose module belongs to one. Disabling and removing pass. The person adds those agents from the Plugins page or the first-run setup, which do not run through the model's tool.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | false | Mounts the service, the guard and the routes; the C16 switch `external_agent_consent`. |
| `runTimeoutMinutes` | 30 | How long one external run may take, 1 to 1440 minutes. |
| `modelRefusedPackages` | `@deepseek-ai/dsh-subagent-claude-code`, `@deepseek-ai/dsh-subagent-codex` | Packages the model's `plugin_manager` calls may not install, enable or configure. |

## Surfaces

- **Approval card.** `@delo/bundle-local` adds "Allow for this workspace" to an `external-agent` card at the home's computer; it records the grant through `POST /api/deloDelegationConsent.allow`, then answers the card. A phone sees "Approve this at your computer."
- **Permissions.** Settings, Permissions lists each grant with its revoke (`GET .grants`, `POST .revoke`).
- **Terminal.** `delorun workspace external-agents [<folder> <agent> on|off]` lists, adds after a terminal confirmation, and revokes grants.

Every route answers only the home's own computer and refuses others with `LOOPBACK_REQUIRED` ([routes](src/routes.ts), [messages](src/wire.ts)).

## Known limitations

- The service decides whether an external agent starts, not what it does: once started it acts under its own settings, outside Delo's sandbox, until it ends or reaches the time limit.
- The review exists only while the row runs. `delorun` checks at start that a profile with the switch on mounts the row enabled and started, as for Delo's other consent rows; a composition started another way has no such check.
- The guard does not cover `plugin_manager`'s undo and restore of an earlier profile state.
- A preset's own plugin rows, such as an agent team preset's, are outside bundle patches; external providers they register are still reviewed, because the review sits in the subagent runtime.

## Tests

[`tests/consent.spec.ts`](tests/consent.spec.ts) proves each refusal and consent against the service and a real `SubagentRuntime`: without consent no provider starts, a read-only chat is refused before any grant counts, a folder outside the workspace and an unreadable grants file refuse, allow-once records nothing, a revoke takes effect at the next start, the guard refuses each install, enable and configure path and passes the rest, a disabled mount provides nothing, and every route refuses a non-loopback caller. The runtime's side, including the time limit, is covered in `packages/subagent/subagent/tests/external-consent.spec.ts`.
