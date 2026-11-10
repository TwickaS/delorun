---
description: "Contract C11: the questions setup asks, the answer schema, the profile writes each answer produces, the --yes and --config forms, and the statements setup makes."
---

# Contract C11: setup answers

English | [中文](c11-setup-answers.zh.md)

<a id="summary"></a>
## Summary

Setup answers are what `delorun setup` asks, the schema that stores each answer, the profile writes each answer produces, and the `--yes` and `--config` forms that give the same answers without a terminal. Setup opens with Quick or Full. Quick asks the privacy note, the stock-home import when a stock home exists, the model key and the prompts question; Full also asks whether to check for new releases and adds the sections that change the computer. Every question takes effect or is not asked. Delo has no telemetry of its own, and the privacy note says that upstream's two opt-ins are off and are changed in Settings → Privacy, where the studio's consent screen owns them, and what the release check requests. A release check turned off in setup is off before Delorun first starts, so it makes no request.

<a id="status"></a>
## Status

`delorun setup` with its Quick and Full flows, the `--yes` and `--config` forms and the profile writes below are built; the stock-home `import` section is built too; the reach, identity-factor and runtime sections are not, and the opt-ins stay off only in the CLI profile.

- **Built and reached:** the sections `privacy`, `import`, `key`, `prompts`, `background` and `profile`; the schema with its refusals of removed keys, of a reach option other than `none` in a document and of unknown fields; the live key check to the provider's origin with redirects refused; the writes that keep upstream's two opt-ins off in the CLI profile; the `updateCheck` answer, which Full setup asks and `delorun setup privacy` changes, written as the `delo-update-check` row's switch before the first start.
- **Not built:** the reach and identity-factor sections and the enrolment request; the runtime section; the check that `modelProvider.id` is a provider upstream ships, which accepts any non-empty id; the feedback dialog and its send, because the CLI profile disables upstream's feedback rows, while setup's privacy note still prints the feedback statement; the rule that a failed key check's reason is not printed, because setup prints it (the reason names the origin and the HTTP status and holds no part of the key).
- **Not reached by Delo's writes:** `delorun headless` runs upstream's headless profile, which carries none of these writes, so DeepSeek's session-log upload is on there by upstream's default and the requirement that the opt-ins are off does not hold for it.

The requirements and denial tests below that this list names as not built or reached by nothing protect no one until a change builds and wires them.

<a id="contents"></a>
## Contents

- [Summary](#summary)
- [Status](#status)
- [Contract](#contract)
  - [Modes and sections](#modes-and-sections)
  - [Questions](#questions)
  - [Answer schema](#answer-schema)
  - [Profile writes](#profile-writes)
  - [The --yes and --config forms](#yes-and-config-forms)
  - [Statements](#statements)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)
- [Decided values](#decided-values)

<a id="contract"></a>
## Contract

<a id="modes-and-sections"></a>
### Modes and sections

The first screen asks for **Quick** (preselected) or **Full**. Each topic is a registered section with an id, a title, a test for whether it applies on this computer, its question, its writes and an optional review line. Quick runs the sections marked `quick`; Full runs every section. `delorun setup <section>` runs one section again on a profile that is set up, and `delorun setup --list` lists them. Later packages add sections through the registry in `delo/apps/cli/src/setup/sections.ts`, each with an order that places it among the others.

| Section | Mode | What it does |
| --- | --- | --- |
| `privacy` | Quick | Shows the privacy note. In Full and in `delorun setup privacy` it asks whether to check for new releases; in Quick it asks nothing and says how to reach that question before Delorun first starts. |
| `import` | Quick | Shown only when `~/.dsh` is a directory, not a link, and the Delo home holds no chat: shows the data part of the stock-home import's preview, then asks "Copy your DeepSeek Harness chats, attachments and workspace list?". |
| `key` | Quick | Asks where the model key comes from. A typed key is checked with one live request before it is stored. |
| `prompts` | Quick | Safer prompts or Same as stock. |
| `background` | Full | Whether Delorun keeps running after the terminal closes. |
| `profile` | Full | The profile's name and the studio's port. |

Every question after the first can return to the one before it: a select or yes-or-no question offers "← Back", and a text or key question takes an empty entry as "go back". A review screen lists the answers before anything is written.

A terminal run ends by offering to install the `delorun` command (it runs `npm install -g delorun`, and prints that line when the person declines or the install fails), then starts Delorun in the background or in the terminal, as the `background` answer says, and opens the studio. It prints whether Delorun keeps running after the terminal closes, the studio's address, and `delorun status`, `delorun logs --follow` and `delorun stop`. On a computer with no display, or in an SSH session, it prints the address and the SSH port-forward line instead of opening a browser. `--yes` and `--config` start nothing and print the command to run.

<a id="questions"></a>
### Questions

Setup asks these questions, in this order. The default applies when the person accepts it, and the `--yes` form uses the default for each question it does not otherwise set.

| Question | Section | Answer | Default |
| --- | --- | --- | --- |
| Check for new releases | `privacy` | Yes or no. Asked in Full, with the note's facts as the hint. | Yes |
| Copy your DeepSeek Harness chats, attachments and workspace list? | `import` | Yes or no, after the preview. | No. |
| Model key | `key` | Typed at the prompt, or read from `DEEPSEEK_API_KEY` at each start. | Typed at the prompt. |
| Prompts | `prompts` | Safer prompts, or Same as stock. | Safer prompts |
| Keep running in the background | `background` | Yes or no. | Yes |
| Profile name and port | `profile` | A profile name and a free port from 1024 to 65535. | The selected profile, and 3080. |

Reach from anywhere, the identity factor and the runtime are not asked yet; their packages add the sections. Setup reads a stock home only to copy from it, and never modifies it. Setup's import copies the data alone: no profile, settings layer, instructions, skill or stored key, which can change what Delo runs or what the agent is told; `delorun import-home` copies each of those after its own yes.

The live key check sends one authenticated model-listing request to the provider's origin, `https://api.deepseek.com` or the origin of `DEEPSEEK_BASE_URL`, and to no other; redirects fail. A failed check prints its reason, which names the origin and the HTTP status and never the key, and lets the person enter the key again or continue without a successful check. `--yes`, `--config` and a key read from the environment skip the check unless `--check-key` is given; with `--check-key` a key the provider does not accept stops an unattended run.

<a id="answer-schema"></a>
### Answer schema

An answers document is a JSON object with the fields below. The same schema is used by the interactive setup, which fills it in, and by `--config`, which reads it.

```json
{
  "schemaVersion": 3,
  "modelProvider": { "id": "deepseek-official", "credential": { "source": "environment", "name": "DEEPSEEK_API_KEY" } },
  "prompts": "safer",
  "background": true,
  "profile": { "name": null, "port": null },
  "reach": { "option": "none", "identityFactor": null },
  "importStockHome": false,
  "updateCheck": true,
  "sections": [{ "id": "privacy", "status": "seen" }, { "id": "key", "status": "answered" }]
}
```

| Field | Type and values | Default | Rule |
| --- | --- | --- | --- |
| `schemaVersion` | Integer `3`, or `2` for a document written before the release-check question. | `3` | Setup refuses any other value. A version-2 document has no `updateCheck`, reads as `true`, and is refused when it carries one. |
| `modelProvider.id` | A provider id. | `deepseek-official` | Any non-empty string is accepted; no check against the providers upstream ships runs. |
| `modelProvider.credential` | `{ "source": "prompt" }` or `{ "source": "environment", "name": "<variable>" }`. | `{ "source": "prompt" }` | `prompt` is accepted only in the interactive form. |
| `prompts` | `safer` or `stock`. | `safer` | Sets the prompt switches of the parity registry. |
| `background` | Boolean. | `true` | Read back by the start commands. |
| `profile.name` | A profile name, or `null` for the profile the command line selected. | `null` | Upstream's profile-name rules; `desktop` is refused. |
| `profile.port` | An integer from 1024 to 65535, or `null` for 3080. | `null` | The interactive form checks that the port is free. |
| `reach.option` | `none`, `tailscale-private`, `tailscale-funnel` or `self-hosted-relay`. | `none` | Any value other than `none` is accepted only in the interactive form. |
| `reach.identityFactor` | `passkey`, `oidc`, `tailnet` or `null`. | `null` | `null` when the option is `none`. `passkey` or `oidc` for `tailscale-funnel` and `self-hosted-relay`. `passkey`, `oidc` or `tailnet` for `tailscale-private`. `tailnet` is available only under C7's socket variant ([C7](c07-reach-providers.md#tailscale-serve-target)); otherwise setup refuses it with `TAILNET_IDENTITY_UNAVAILABLE`. `passkey` on a `ts.net` address is available only where C14 makes passkeys available there ([C14](c14-oidc-passkeys.md#relying-party-ids)); otherwise setup refuses it with `PASSKEY_UNAVAILABLE`. |
| `importStockHome` | Boolean. | `false` | Set by the import section. `--config` refuses `true`, because the import shows its preview before it asks. |
| `updateCheck` | Boolean; optional. | `true` | Whether Delo checks the release channel for a newer release. `--no-update-check` sets it to `false` in every form. |
| `sections` | A list of `{ "id", "status" }`, in flow order. | `[]` | Written by setup, never by a document. `seen` is a note shown, `answered` a question answered, `skipped` a section that took its default without being asked. The studio's onboarding leaves out what the terminal covered. |

Earlier versions asked for the runtime, the studio additions, help with other models, desktop analytics and DeepSeek's session-log upload. Setup recorded those answers and applied none of them, so it no longer asks them. An answers document that carries `studioAdditions`, `runtime`, `helpSetUpModels`, `sessionLogUpload` or `desktopAnalytics` is refused with a message that names the removed keys. The two opt-ins stay off, and the studio's Settings → Privacy section changes them.

The answers document never contains a credential value. A credential is either entered at the prompt and stored through upstream's credential store, or read from the environment variable named by `credential.name`.

<a id="profile-writes"></a>
### Profile writes

Each answer produces the writes below. Config writes go to the per-profile `cordis.patch.yml` of the profile the answer applies to, and upstream applies that file after the bundles.

| Answer | Write | Target |
| --- | --- | --- |
| `modelProvider` | A typed key goes to upstream's credential store, `.credentials.yaml` under the home, at mode 0600. A key read from the environment is stored nowhere. | The home. |
| `prompts` | `config.enabled` of the rows `delo-permission-defaults`, `delo-instruction-consent`, `delo-mcp-consent` and `delo-schedule-consent`, set to each switch's Delo default (`safer`) or parity value (`stock`) in contract C16's registry. The fetch guard is a refusal, not a prompt, and no answer changes it. | The profile's `cordis.patch.yml`. |
| `background` | Recorded in the answers record `setup-answers.json`; the start commands read it. | The profile directory. |
| `profile.name` | The CLI profile is created under this name. | The home. |
| `profile.port` | The `webserver` row with the port, restating the Web bundle's other keys. Not written for the default port. | The profile's `cordis.patch.yml`. |
| `reach.option` | The reach rows of the reach contracts. `none` writes none. | The profile. Written only in the interactive form. |
| `reach.identityFactor` | An enrolment request for the reach address. No config row. | Home-auth state, under the identity contracts. |
| `importStockHome` | The data of the stock-home import of [C8](c08-archive-and-trash.md#the-stock-home-import): exactly the plan the section's preview showed, under the home lock of every profile. A stock file that changed since, a Delo home that gained a chat since, or a run that did not show the preview refuses it. | The home. |
| `updateCheck` | `false` writes the `delo-update-check` row as Settings → Privacy saves it: its id, its plugin name and the bundle's config with `enabled: false`. `true` leaves no config on that row, so the bundle's `enabled: true` applies. | The profile's `cordis.patch.yml`, before Delorun first starts. |
| `sections` | Recorded in `setup-answers.json`. | The profile directory. |

Upstream's session-telemetry row `session-telemetry-otel` is not an answer. In upstream's profiles it sends a session-log prefix only after the person submits feedback. The CLI profile disables it together with upstream's feedback command and message feedback rows, so nothing sends feedback there.

<a id="yes-and-config-forms"></a>
### The --yes and --config forms

`--yes` accepts every default. It applies no answer other than the defaults and `--no-update-check`, and it reads the model credential from the environment variable that `credential.name` names, which defaults to `DEEPSEEK_API_KEY`. When that variable is unset, setup stops with a typed error that names the variable.

`--config <file>` reads an answers document with the schema above, and applies its answers under the same rules as `--yes`; `--no-update-check` turns the release check off whatever the document says. A document whose `reach.option` is not `none` is refused with a typed error that names the field, and so is a document whose `importStockHome` is `true`. A document that carries a removed key is refused with a message that names the removed keys. A document that carries a credential value, in any field, is refused without echoing that value.

For identical answers, the interactive form and the `--yes` or `--config` form write identical profile files.

Setup resumes an interrupted run at the first step that did not finish. A step that runs again writes the same values.

<a id="statements"></a>
### Statements

Setup shows the privacy note at the start of every terminal run, and prints it before an unattended run.

- Delo has no telemetry of its own.
- Upstream's desktop analytics and DeepSeek's session-log upload are off unless you turn them on, and Settings → Privacy changes them.
- Upstream's feedback send includes a session-log prefix, and it happens only when you send feedback. The CLI profile has no feedback send, so this statement describes upstream's profiles only.
- Delo checks once a day whether a newer release exists, which hosts it fetches from, that it sends nothing about the installation and its plugins, that those hosts see the computer's address, and that Settings → Privacy turns it off.

The statements about recovery and Docker belong to the sections that add those topics.

<a id="consumers"></a>
## Consumers

- `delo/apps/cli/src/setup/`: the setup flow, its sections and its `--yes` and `--config` forms.
- `delo/packages/bundle-local`: the upstream opt-in rows and their consent screen in the studio, and the rows the prompts answer sets.
- `delo/packages/plugin-onboarding`, which `@delo/bundle-studio` mounts: the studio's onboarding reads `sections` from `setup-answers.json`; the rest of its rules are in the [first-run design](../design/first-run.md).
- `delo/packages/contract-setup-answers/`: the answer types, the defaults and the profile row names.

<a id="compatibility"></a>
## Compatibility

The answers schema is versioned by `schemaVersion`, which is `3`. A change that adds a question with a safe default keeps the version when an older reader that ignores the new field writes the same profile. A change that alters the meaning of an existing answer, or that removes a field, increments the version; version 2 removed five fields. Version 3 added `updateCheck`: a reader that ignored `false` would leave the release check on, so the version increments. Setup reads a version-2 document as version 3 with `updateCheck: true` and records it as version 3. Setup refuses an answers document whose version it does not know.

A new upstream opt-in is added as a question with a default of off, in the same change that adds its profile row to the mapping.

<a id="security"></a>
## Security

Requirements:

- `--yes` and `--config` never enable reach or credential forwarding.
- Upstream's opt-ins are not asked by setup and are off by default. They take effect only when the person turns them on on the consent screen.
- The live key check sends the key to the provider's origin only, and neither the key nor a check's reason is printed or logged.
- Delo sends no telemetry of its own.
- A credential value never appears in an answers document, a profile file, a process argument or a log.
- Setup writes no row that enables credential forwarding. Forwarding is set per workspace under the runtime contract.

Denial tests:

| Test name | Behaviour proven |
| --- | --- |
| `yes run leaves reach and credential forwarding off` | After `--yes`, the profile contains no reach row and no forwarding row. |
| `config file cannot enable reach` | A document whose `reach.option` is not `none` is refused with a typed error that names `reach.option`. |
| `refuses a document that asks for the stock-home import, which shows its preview in a terminal first` | A document whose `importStockHome` is `true` is refused with a typed error that names the field. |
| `config file with a removed key is refused` | A document that carries a removed key is refused with a typed error that names the removed keys and no value. |
| `config file carrying a credential value is refused` | A document with a credential value in any field is refused, and the value is not echoed. |
| `live key check sends the key to the provider origin only` | The check's request goes to one origin, with redirects refused, and the key is in no URL, message or output. |
| `typed key is never printed` | The recorded screen of a run holds no part of the typed key. |
| `default-profile run sends no analytics or upload` | A network fixture records no request to an analytics destination and no session-log upload in a default profile. |
| `default-profile model request carries no dsh_session_log` | A model request from a default profile has no `dsh_session_log` field. |
| `update-notice-off-at-first-start` | After a Full setup that answers No, and after `--yes --no-update-check`, the profile the first start composes has the `delo-update-check` row with `enabled: false`, and the row mounts no check service. |

Acceptance tests:

- `setup states the telemetry statement and that both opt-ins are off`.
- `the Quick flow reads as the transcript in the specs, top to bottom`.
- `Same as stock sets every prompt switch to its parity value`.
- `interactive and --yes runs write identical profile files`.
- `interrupted setup resumes without a repeated write`.
- `consent screen turns each upstream opt-in on alone and off again from the same screen`.
- `a way back returns to the previous question with the earlier answers kept`.
- `sits between the privacy note and the key in a Quick setup, and copies the chats before the key is asked for`.
- `delorun setup privacy shows the note, turns the check off, and turns it on again by removing the row`.

<a id="decided-values"></a>
## Decided values

- The answers schema version is `3`; setup also reads version 2.
- The defaults are `deepseek-official` for the provider, safer prompts, background running on, port 3080, `none` for reach, off for the stock-home import, which the import section also preselects as no when it is shown, and on for the release check.
- The default credential variable is `DEEPSEEK_API_KEY`.
- The reach options of setup are `none`, `tailscale-private`, `tailscale-funnel` and `self-hosted-relay`.
- The feedback send is not an answer, and setup states it.
