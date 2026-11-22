---
description: "Contract C11: the questions setup asks, the model providers it sets up, the answer schema, the profile writes each answer produces, the --yes and --config forms, and the statements setup makes."
---

# Contract C11: setup answers

English | [中文](c11-setup-answers.zh.md)

<a id="summary"></a>
## Summary

Setup answers are what `delorun setup` asks, the schema that stores each answer, the profile writes each answer produces, and the `--yes` and `--config` forms that give the same answers without a terminal. Setup in a terminal asks few questions: a one-line privacy note with no question, "Use Delorun from your other devices too? (phone, tablet, another computer, over Tailscale)", the DeepSeek Harness import when a stock home exists, and the studio port when 3080 is busy; a Yes to other devices also asks whether to hold changes for review. It does not ask how the person will use Delorun, and it shows no review screen. The model key, prompts, background running, the release check, the profile name and changes protection are answered with `delorun setup <section>` or in the studio. Every question takes effect or is not asked. Delorun has no telemetry of its own, and the privacy note says that upstream's two opt-ins are off and are changed in Settings → Safety → Privacy, where the studio's consent screen owns them, and what the release check requests. A release check turned off in setup is off before Delorun first starts, so it makes no request.

<a id="status"></a>
## Status

`delorun setup` with its short question flow, the `--yes` and `--config` forms and the profile writes below are built; the stock-home `import` section and the `reach` section for Tailscale on the person's own tailnet are built too; the other reach options, the passkey and OIDC identity factors and the runtime section are not, and the opt-ins stay off only in the CLI profile.

- **Built and reached:** the sections `privacy`, `import`, `key`, `prompts`, `background`, `reach`, `changes-protection` and `profile`, where `reach` offers only `none` or `tailscale-private` with the factor `tailnet-membership`; the eleven model providers of [Model providers](#model-providers), each with its live key check and its profile rows; the schema with its refusals of removed keys, of a provider setup does not offer, of a model the provider's installed catalogue does not list, of a reach option other than `none` in a document and of unknown fields; the live key check to the provider's origin with redirects refused; the writes that keep upstream's two opt-ins off in the CLI profile; the `updateCheck` answer, which `delorun setup privacy` asks and changes, written as the `delorun-update-check` row's switch before the first start.
- **Not built:** the reach options `tailscale-funnel` and `self-hosted-relay`, the `passkey`, `oidc` and `tailnet` identity factors and the enrolment request; the runtime section; the feedback dialog and its send, because the CLI profile disables upstream's feedback rows, while setup's privacy note still prints the feedback statement; the rule that a failed key check's reason is not printed, because setup prints it (the reason names the origin and the HTTP status and holds no part of the key).
- **Not reached by Delorun's writes:** `delorun headless` runs upstream's headless profile, which carries none of these writes, so DeepSeek's session-log upload is on there by upstream's default and the requirement that the opt-ins are off does not hold for it.

The requirements and denial tests below that this list names as not built or reached by nothing protect no one until a change builds and wires them.

<a id="contents"></a>
## Contents

- [Summary](#summary)
- [Status](#status)
- [Contract](#contract)
  - [Use cases and sections](#modes-and-sections)
  - [Questions](#questions)
  - [Model providers](#model-providers)
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
### Use cases and sections

Setup does not ask how the person will use Delorun. The answers keep the `useCase` field: the main flow sets `remote` when the person answers Yes to the other-devices question, even when the Tailscale check then leaves remote access off, and `local` otherwise; `automation` comes only from a `--config` document. The use case changes no question and no default; the next steps setup prints read it.

Each topic is a registered section with an id, a title, a main-flow placement, a test for whether it applies on this computer, its question and its writes. The placement is `asked` (the main flow asks it), `note` (the main flow shows its note without a question) or `never` (only `delorun setup <section>` asks it); a placement may depend on the answers so far. `delorun setup <section>` runs one section again on a profile that is set up, in full, and `delorun setup --list` lists them. Later packages add sections through the registry in `delorun/apps/cli/src/setup/sections.ts`, each with an order that places it among the others.

| Section | Main flow | What it does |
| --- | --- | --- |
| `privacy` | `note` | The main flow shows one line, "Delorun sends nothing about you. Details: https://delorun.com/privacy". `delorun setup privacy` shows the privacy statements, including what the release check requests, and asks whether to check for new releases. |
| `reach` | `asked` | In the main flow, "Use Delorun from your other devices too? (phone, tablet, another computer, over Tailscale)" with "No, just this computer" (the default) and "Yes, over Tailscale". A Yes runs the Tailscale checks of `delorun reach on tailscale`, Funnel included, and shows the trust statement; the pairing choice stays at the safe default (only devices signed in as this computer's Tailscale user). A failed check leaves remote access off and names what to fix. `delorun setup reach` asks the full form, including whether any device on the tailnet may ask to pair. Applying it writes the reach row with a fixed listener port. |
| `changes-protection` | `asked` after a Yes to other devices, otherwise `never` | Shows one line on what changes protection ([C21](c21-changes.md)) means at its current setting, then asks whether changes to the person's plugins and to Delorun itself wait for their review before they load. The answer defaults to no. After a No to other devices, or a Yes whose check failed, the section is recorded as skipped and `delorun setup changes-protection` asks it. |
| `import` | `asked` | Shown only when `~/.dsh` is a directory, not a link, and the Delorun home holds no chat: "Copy your N DeepSeek Harness chats?" over a summary ("Will copy: N chats · N attachments · N workspaces", "Stays behind: N unfinished chats · N locks, caches and packages", "Your DeepSeek Harness folder is only read."), with Yes, "Later (delorun import-home)" and "Show what stays behind", which shows the full list and asks again. The full list is also written to `import-preview.txt` in the Delorun home, readable by its owner alone. |
| `key` | `never` | Asks the model provider (DeepSeek, More providers, or Choose later), where its key comes from, with the provider's key page when one is known and one line on what an environment variable is, and the model new chats start on ([Model providers](#model-providers)). A typed key is checked with one live request before it is stored. A key variable that is unset in the terminal produces a warning with the fix at once. The studio's Models step takes the key on first open. |
| `prompts` | `never` | Ask me first (`safer`), Ask less (`stock`), or Never ask (dangerous), which is always listed last, prints a warning, asks a yes-or-no that starts on No, and then asks for the exact phrase `full access everywhere`; anything else keeps the previous answer. "← Back" from the confirmation returns to the prompts question. |
| `background` | `never` | Whether Delorun keeps running after the terminal closes. |
| `profile` | `asked`, but only when the port is busy | The profile's name and the studio's port. The main flow asks nothing while 3080 is free, and asks "Port 3080 is in use. Use 3081?" with Yes and "Enter another port" when it is busy. It never asks for a profile that is set up, whose own studio may hold the port. `delorun setup profile` asks the name and the port in full. |

Every question after the first can return to the nearest earlier question that was asked: a select or yes-or-no question offers "← Back", and a text or key question takes an empty entry as "go back". Nothing is written until the last question is answered.

Every form ends the same way and starts nothing: it prints "Delorun is set up. Nothing is running yet." and numbered next steps for the use case. For `local` and `remote`: start Delorun and open the studio with `delorun`, and the install guide's first-chat section (`https://docs.delorun.com/guide/install#the-studio-and-your-first-chat`). For `remote` also `delorun devices approve`, or how to turn remote access on when the Tailscale check failed. For `automation`: `delorun headless "your task"`. A step comes first when it is needed: installing the `delorun` command at the launcher's version (`DELORUN_LAUNCHER_VERSION`) when `npx` started the run, adding a model key when none was chosen, or setting a key variable that is unset. The last lines say how to change an answer (`delorun setup <section>`, `delorun setup --list`) and name `delorun doctor`. An interrupt (Ctrl-C) at any question exits with code 130 and prints "Setup cancelled. Nothing was saved. Run delorun to start again."; an interrupt while an earlier run's answers are kept says that instead.

<a id="questions"></a>
### Questions

Setup asks these questions, in this order. The default applies when the person accepts it, and the `--yes` form uses the default for each question it does not otherwise set.

| Question | Section | Answer | Default |
| --- | --- | --- | --- |
| Check for new releases | `privacy` | Yes or no. Asked by `delorun setup privacy` only, with each choice's lines. | Yes |
| Copy your N DeepSeek Harness chats? | `import` | Yes, Later, or Show what stays behind, after the summary. | Yes; `--import-dsh` preselects it. |
| Model provider | `key` | DeepSeek, one of the other providers of [Model providers](#model-providers) behind More providers, or Choose later. Asked by `delorun setup key` only. | DeepSeek in `delorun setup key`; none in a whole setup. |
| Base URL and model id | `key` | Asked for an `openai-compatible` endpoint only. | None. |
| Model key | `key` | Typed at the prompt, or read from the provider's variable at each start. | Typed at the prompt. |
| Model | `key` | One model of the provider's installed catalogue. Asked for every provider but DeepSeek, whose default is the profile's and which `delorun setup key` asks. | The provider's recommended model in setup's provider table, a current general chat model its catalogue lists; for DeepSeek, the profile's default. |
| Prompts | `prompts` | Ask me first (`safer`), Ask less (`stock`), or Never ask (dangerous); `--yes` never selects dangerous. | Ask me first |
| Keep running in the background | `background` | Yes or no. Asked by `delorun setup background` only. | Yes |
| Use Delorun from your other devices too? | `reach` | "No, just this computer" or "Yes, over Tailscale"; `delorun setup reach` asks it as "Open Delorun from your phone or another device over Tailscale?" with a yes-or-no. | No; `--phone` (alias `--devices`) preselects Yes. |
| Hold changes to your plugins and to Delorun itself for your review before they load? | `changes-protection` | Yes or no, asked after a Yes to other devices and by `delorun setup changes-protection`. No leaves the home's setting as it is, and setup never turns protection off. | No; yes when protection is already on. |
| Port 3080 is in use. Use 3081? | `profile` | Yes or "Enter another port", a free port from 1024 to 65535. Asked only when the default port is busy. | 3080 when it is free; `--port <n>` preselects a port. |
| Profile name and port | `profile` | A profile name and a free port from 1024 to 65535. Asked by `delorun setup profile` only. | The selected profile, and 3080. |

Reach beyond the person's tailnet, a passkey or OIDC identity factor and the runtime are not asked; Delorun does not include them in setup ([roadmap](../guide/roadmap.md)). Setup reads a stock home only to copy from it, and never modifies it. Setup's import copies the data alone: no profile, settings layer, instructions, skill or stored key, which can change what Delorun runs or what the agent is told; `delorun import-home` copies each of those after its own yes.

The live key check sends one authenticated `GET` of a metadata endpoint to the provider's origin, and to no other; redirects fail. DeepSeek's check goes through upstream's model-listing client, which parses the response body; every other check settles on the status and never reads the body. No check prints the body, and none requests a completion. A failed check prints its reason, which names the origin and the HTTP status and never the key, and lets the person enter the key again or continue without a successful check. `--yes`, `--config` and a key read from the environment skip the check unless `--check-key` is given; with `--check-key` a key the provider does not accept stops an unattended run.

<a id="model-providers"></a>
### Model providers

Setup offers the providers below, listed by name so that none is placed ahead of another. DeepSeek runs on upstream's DeepSeek adapter, the profile's `llm-deepseek` row, and needs no install. Every other provider is a route of upstream's pi-ai adapter, the `llm-pi-ai` row: a route of pi-ai's installed catalogue, whose endpoint and models the catalogue supplies, or the `openai-compatible` route, which setup declares with the base URL and model the person gives. Every provider the profile's adapters serve and setup does not offer, including the rest of pi-ai's catalogue, is set up in the studio's Settings → Agent → Models.

| Provider | Id | Key variable | Key check |
| --- | --- | --- | --- |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `GET /v1/models?limit=1` with `x-api-key` and `anthropic-version` |
| DeepSeek | `deepseek-official` | `DEEPSEEK_API_KEY` | `GET /models` at `https://api.deepseek.com` or the origin of `DEEPSEEK_BASE_URL`, with `x-api-key`, through upstream's model-listing client |
| Google Gemini | `google` | `GEMINI_API_KEY` | `GET /models?pageSize=1` with `x-goog-api-key` |
| Groq | `groq` | `GROQ_API_KEY` | `GET /models` with a bearer token |
| Mistral | `mistral` | `MISTRAL_API_KEY` | `GET /v1/models` with a bearer token |
| Moonshot AI | `moonshotai` | `MOONSHOT_API_KEY` | `GET /models` with a bearer token |
| OpenAI | `openai` | `OPENAI_API_KEY` | `GET /models` with a bearer token |
| OpenAI-compatible endpoint | `openai-compatible` | `OPENAI_COMPATIBLE_API_KEY` | `GET /models` under the base URL the person gives, with a bearer token |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `GET /key` with a bearer token |
| Together AI | `together` | `TOGETHER_API_KEY` | `GET /models` with a bearer token |
| xAI | `xai` | `XAI_API_KEY` | `GET /models` with a bearer token |

Each catalogue provider's path is appended to the endpoint pi-ai's installed catalogue ships for it. A typed key is stored under the key variable, which is the credential reference the adapter reads; a key read from the environment is read from the key variable, or from the variable `--key-env` or a document names. An endpoint that answers its model listing without any key also passes the `openai-compatible` check.

The key variables are the names each provider's own tools read, and some differ from the reference Settings → Agent → Models derives from the route when it stores a key: setup uses `GEMINI_API_KEY` where the studio derives `GOOGLE_API_KEY`, and `MOONSHOT_API_KEY` where it derives `MOONSHOTAI_API_KEY`. The route's `apiKeyEnv` records the variable setup used, so the adapter and the studio read the key from it.

A base URL is an `http` or `https` URL with no user name, password, query or fragment, so it carries no credential; setup refuses any other, without repeating it. A base URL that reaches a host other than this computer's loopback addresses (`localhost`, `127.0.0.0/8`, `::1`) over plain `http` is accepted with a warning, a note in a terminal and a line on standard error otherwise, because the key and every prompt then cross the network unencrypted. A model id holds letters, digits and `. _ : / @ ~ + -` only, up to 200 characters.

<a id="answer-schema"></a>
### Answer schema

An answers document is a JSON object with the fields below. The same schema is used by the interactive setup, which fills it in, and by `--config`, which reads it.

```json
{
  "schemaVersion": 5,
  "useCase": "local",
  "modelProvider": { "id": "anthropic", "credential": { "source": "environment", "name": "ANTHROPIC_API_KEY" }, "baseURL": null, "model": "claude-sonnet-5" },
  "prompts": "safer",
  "background": true,
  "profile": { "name": null, "port": null },
  "reach": { "option": "none", "identityFactor": null },
  "importStockHome": false,
  "protectChanges": false,
  "updateCheck": true,
  "sections": [{ "id": "privacy", "status": "seen" }, { "id": "key", "status": "answered" }]
}
```

| Field | Type and values | Default | Rule |
| --- | --- | --- | --- |
| `schemaVersion` | Integer `5`, or `2`, `3` or `4` for a document written earlier. | `5` | Setup refuses any other value. A version-2, version-3 or version-4 document that holds `phonePowers` is read with that key ignored and a line on standard error saying so; a version-5 document that holds it is refused as an unknown field (`IGNORED_ANSWER_KEYS` in `@delorun/contract-setup-answers`). A version-2 document has no `updateCheck`, reads as `true`, and is refused when it carries one. A version-2 or version-3 document's `modelProvider` holds `id` and `credential` only, and reads as `deepseek-official` with its credential and the profile's default model, because setup of those versions applied DeepSeek's key and no other provider. One that names another id is refused with a message that it needs schema version 4. |
| `useCase` | `local`, `remote` or `automation`. | `local` | Whether the person set up device access. Nothing asks it: the main flow sets `remote` for a Yes to other devices and `local` otherwise, `--yes` keeps `local`, and a `--config` document stores any value and asks nothing. The next steps setup prints read it. A `remote` document cannot enable reach, so remote access is turned on with `delorun setup reach`. A record written before the use case existed has none and reads as `local`; its `mode` key (`quick` or `full`, written by the setup that asked Quick or Full) is read and ignored, and any other `mode` value is refused. |
| `modelProvider` | An object with the four fields below, or `null` for no provider. | The object with each field's default in a terminal; `null` with `--yes` unless `--provider` is given. | `null` writes no provider row and leaves the rows already there, so new chats keep the model the profile selected; setup says which. |
| `modelProvider.id` | An id of [Model providers](#model-providers). | `deepseek-official` | Any other id is refused, naming the ids setup accepts. |
| `modelProvider.credential` | `{ "source": "prompt" }` or `{ "source": "environment", "name": "<variable>" }`. | `{ "source": "prompt" }` | `prompt` is accepted only in the interactive form. |
| `modelProvider.baseURL` | An `http` or `https` URL, or `null`. | `null` | Set for `openai-compatible` and `null` for every other provider, under the base URL rule of [Model providers](#model-providers). |
| `modelProvider.model` | A model id, or `null`. | `null` | `null` only for `deepseek-official`, where it keeps the profile's default model. Every other provider names a model, which must be in the provider's installed catalogue unless the provider is `openai-compatible`. A model that is not a model id, or not in the catalogue, is refused naming the field and not its value. |
| `prompts` | `safer`, `stock` or `dangerous`; `dangerous` needs `acceptDangerousMode: true` in the document (`--prompts dangerous --accept-dangerous-mode` with `--yes`), is refused for a root user, and `acceptDangerousMode` is read and never stored. | `safer` | Sets the prompt switches of the parity registry. |
| `background` | Boolean. | `true` | Read back by the start commands. |
| `profile.name` | A profile name, or `null` for the profile the command line selected. | `null` | Upstream's profile-name rules; `desktop` is refused. |
| `profile.port` | An integer from 1024 to 65535, or `null` for 3080. | `null` | The interactive form checks that the port is free. |
| `reach.option` | `none`, `tailscale-private`, `tailscale-funnel` or `self-hosted-relay`. | `none` | Any value other than `none` is accepted only in the interactive form. |
| `reach.identityFactor` | `passkey`, `oidc`, `tailnet`, `tailnet-membership` or `null`. | `null` | `null` when the option is `none`. The built `reach` section records `tailnet-membership` for `tailscale-private`. `passkey` or `oidc` for `tailscale-funnel` and `self-hosted-relay`. `passkey`, `oidc` or `tailnet` for `tailscale-private`. `tailnet` is available only under C7's socket variant ([C7](c07-reach-providers.md#tailscale-serve-target)); otherwise setup refuses it with `TAILNET_IDENTITY_UNAVAILABLE`. `passkey` on a `ts.net` address is available only where C14 makes passkeys available there ([C14](c14-oidc-passkeys.md#relying-party-ids)); otherwise setup refuses it with `PASSKEY_UNAVAILABLE`. |
| `importStockHome` | Boolean. | `false` | Set by the import section. `--config` refuses `true`, because the import shows its summary before it asks. |
| `protectChanges` | Boolean. | `false` | Set by the `changes-protection` section; an absent field reads as `false`. `--config` refuses `true`, because only a terminal proof changes the protection setting ([C21](c21-changes.md)). |
| `updateCheck` | Boolean; optional. | `true` | Whether Delorun checks the release channel for a newer release. `--no-update-check` sets it to `false` for a whole setup run in every form; `delorun setup <section>` refuses it, and `delorun setup privacy` asks the question instead. |
| `sections` | A list of `{ "id", "status" }`, in flow order. | `[]` | Written by setup, never by a document. `seen` is a note shown, `answered` a question answered, `skipped` a section that took its default without being asked. The studio's onboarding leaves out what the terminal covered. |

Earlier versions asked for the runtime, the studio additions, help with other models, desktop analytics and DeepSeek's session-log upload. Setup recorded those answers and applied none of them, so it no longer asks them. An answers document that carries `studioAdditions`, `runtime`, `helpSetUpModels`, `sessionLogUpload` or `desktopAnalytics` is refused with a message that names the removed keys. The two opt-ins stay off, and the studio's Settings → Safety → Privacy section changes them.

The answers document never contains a credential value. A credential is either entered at the prompt and stored through upstream's credential store, or read from the environment variable named by `credential.name`.

<a id="profile-writes"></a>
### Profile writes

Each answer produces the writes below. Config writes go to the per-profile `cordis.patch.yml` of the profile the answer applies to, and upstream applies that file after the bundles.

| Answer | Write | Target |
| --- | --- | --- |
| `modelProvider` | A typed key goes to upstream's credential store, `.credentials.yaml` under the home, at mode 0600, under the provider's key variable. A key read from the environment is stored nowhere. | The home. |
| `modelProvider` | The rows in the form Settings → Agent → Models and the model picker save them: DeepSeek with `DEEPSEEK_API_KEY` and the profile's default model writes no row, as stock DeepSeek Harness composes the profile; another variable sets `apiKeyEnv` on `llm-deepseek`. A pi-ai provider sets its route under `llm-pi-ai`'s `providers`, keeping the routes already there: `apiKeyEnv` for a catalogue route, and also `displayName`, `api: openai-completions`, `baseURL` and the model in `models` for `openai-compatible`. A named model sets `agent-default-model` to the provider and model without a reasoning effort. `null` writes none of these rows. | The profile's `cordis.patch.yml`. |
| `prompts` | `config.enabled` of the rows `delorun-permission-defaults`, `delorun-instruction-consent`, `delorun-mcp-consent` and `delorun-schedule-consent`, set to each switch's Delorun default (`safer`, Ask me first) or parity value (`stock`, Ask less) in contract C16's registry. With `safer` the person allows a workspace's full access, and a new stdio MCP server, at the home's computer: in the studio's Settings, Permissions, or with `delorun workspace full-access` and `delorun mcp`; with `stock` neither consent is mounted and those surfaces say the profile does not ask. The fetch guard is a refusal, not a prompt, and no answer changes it; nor does any answer change the external-agent consent (`delorun-delegation-consent`), which the person switches in Settings, Permissions. With `dangerous` the three consent rows take their parity values, `delorun-permission-defaults` stays on, and every answer sets its `fullAccessEverywhere` to whether the answer is `dangerous`; `dangerous` also writes the grant file `<home>/secrets/permission-defaults/full-access-everywhere.json` (mode 0600, `{ "v": 1, "grantedAt", "warning": 1 }`) under the permission store's lock after the rows, and `safer` and `stock` remove it. Full access is available everywhere only while both the row setting and a valid grant file hold. | The profile's `cordis.patch.yml`, and for the grant file the home's `secrets/permission-defaults/`. |
| `background` | Recorded in the answers record `setup-answers.json`; the start commands read it. | The profile directory. |
| `profile.name` | The CLI profile is created under this name. | The home. |
| `profile.port` | The `webserver` row with the port, restating the Web bundle's other keys. Not written for the default port. | The profile's `cordis.patch.yml`. |
| `reach.option` | The reach rows of the reach contracts. `none` writes none. | The profile. Written only in the interactive form. |
| `reach.identityFactor` | An enrolment request for the reach address. No config row. | Home-auth state, under the identity contracts. |
| `importStockHome` | The data of the stock-home import of [C8](c08-archive-and-trash.md#the-stock-home-import): exactly the plan the section's preview showed, under the home lock of every profile. A stock file that changed since, a Delorun home that gained a chat since, or a run that did not show the preview refuses it. | The home. |
| `protectChanges` | `true` writes `changes/protection.json` with the level `on`, at mode 0600 under a 0700 `changes/`, through the terminal proof `delorun changes protection on` uses, taken from setup's own standard input and output. Nothing is written when protection is already on or the answer is `false`. When either stream is not a terminal, setup stops before the write and names how to finish: `delorun setup` in a terminal resumes the step, or `delorun changes protection on` turns it on. | The home. |
| `updateCheck` | `false` writes the `delorun-update-check` row as Settings → General → Updates saves it: its id, its plugin name and the bundle's config with `enabled: false`. `true` leaves no config on that row, so the bundle's `enabled: true` applies. | The profile's `cordis.patch.yml`, before Delorun first starts. |
| `sections` | Recorded in `setup-answers.json`. | The profile directory. |

Upstream's session-telemetry row `session-telemetry-otel` is not an answer. In upstream's profiles it sends a session-log prefix only after the person submits feedback. The CLI profile disables it together with upstream's feedback command and message feedback rows, so nothing sends feedback there.

<a id="yes-and-config-forms"></a>
### The --yes and --config forms

`--yes` keeps the `local` use case, accepts every default but the provider, and applies no answer other than the defaults, the provider flags, `--prompts`, `--no-update-check`, `--phone` (or `--devices`), `--import-dsh` and `--port`. `delorun setup` without `--yes`, `--config` or a section, on a standard input that is not a terminal, takes the same answers and flags instead of refusing; `delorun` with no command does the same on a home without a CLI profile. `--phone` (alias `--devices`) turns device access on with the checks the question runs and fails with the check's message when Tailscale is not ready; `--import-dsh` prints the import summary and copies the chats, or says in one line that there is no stock home to copy; `--port <n>` takes a studio port from 1024 to 65535 and fails when it is in use. In a terminal the three flags preselect their questions, and in a whole setup they are refused with a section or a `--config` document. Without `--provider` it sets up no provider, whatever keys the environment holds, and prints how to add one: `delorun setup key` in a terminal or with the provider flags, or the studio's Settings → Agent → Models. `--provider <id>` names a provider of [Model providers](#model-providers), `--model <id>` its model, which every provider but DeepSeek needs, `--base-url <url>` the endpoint of `openai-compatible` and of no other provider, and `--key-env <NAME>` the variable the key is read from at each start, which defaults to the provider's key variable. A key is never accepted on the command line, and a `--key-env` value that is not a variable name is refused without being echoed. When the variable is unset, setup stops with a typed error that names it. `delorun setup key` takes the same flags on a profile that is set up and then asks nothing. `--check-key` without a provider is refused with the usage code.

`--config <file>` reads an answers document with the schema above, and applies its answers under the same rules as `--yes`; its provider is the one `modelProvider` names, and the provider flags are refused beside it; `--no-update-check` turns the release check off whatever the document says. A document whose `reach.option` is not `none` is refused with a typed error that names the field, and so is a document whose `importStockHome` or `protectChanges` is `true`. Neither form changes the protection setting. A document that carries a removed key is refused with a message that names the removed keys. A document that carries a credential value, in any field, is refused without echoing that value.

For identical answers, the interactive form and the `--yes` or `--config` form write identical profile files.

Setup resumes an interrupted run at the first step that did not finish. A step that runs again writes the same values.

<a id="statements"></a>
### Statements

Setup shows the privacy note at the start of every terminal run, and prints it before an unattended run.

- Delorun has no telemetry of its own.
- Upstream's desktop analytics and DeepSeek's session-log upload are off unless you turn them on, and Settings → Safety → Privacy changes them.
- Upstream's feedback send includes a session-log prefix, and it happens only when you send feedback. The CLI profile has no feedback send, so this statement describes upstream's profiles only.
- Delorun checks once a day whether a newer release exists, which hosts it fetches from, that it sends nothing about the installation and its plugins, that those hosts see the computer's address, and that Settings → General → Updates turns it off.

The statements about recovery and Docker belong to the sections that add those topics.

<a id="consumers"></a>
## Consumers

- `delorun/apps/cli/src/setup/`: the setup flow, its sections and its `--yes` and `--config` forms.
- `delorun/packages/bundle-local`: the upstream opt-in rows and their consent screen in the studio, and the rows the prompts answer sets.
- `delorun/packages/plugin-onboarding`, which `@delorun/bundle-studio` mounts: the studio's onboarding reads `sections` from `setup-answers.json`; the rest of its rules are in the [first-run design](../design/first-run.md).
- `delorun/packages/contract-setup-answers/`: the answer types, the defaults and the profile row names.

<a id="compatibility"></a>
## Compatibility

The answers schema is versioned by `schemaVersion`, which is `5`. A change that adds a question with a safe default keeps the version when an older reader that ignores the new field writes the same profile; `useCase` is such a field, because the answers it sets are stored beside it and the profile files do not depend on it. A change that alters the meaning of an existing answer, or that removes a field, increments the version; version 2 removed five fields. Version 3 added `updateCheck`: a reader that ignored `false` would leave the release check on, so the version increments. Version 4 gave `modelProvider.id` its meaning and added `baseURL`, `model` and `null`: a version-3 reader ignores the id and would store an Anthropic key as DeepSeek's, so the version increments. Version 5 removed `phonePowers`, so the version increments. Setup reads a version-2, version-3 or version-4 document as version 5, as [Answer schema](#answer-schema) describes, and records it as version 5. Setup refuses an answers document whose version it does not know.

A new upstream opt-in is added as a question with a default of off, in the same change that adds its profile row to the mapping.

<a id="security"></a>
## Security

Requirements:

- `--yes` and `--config` never enable reach or credential forwarding.
- Setup changes the protection setting only with a terminal proof, and only to turn it on.
- Upstream's opt-ins are not asked by setup and are off by default. They take effect only when the person turns them on on the consent screen.
- The live key check sends the key to the provider's origin only, and neither the key nor a check's reason is printed or logged.
- Delorun sends no telemetry of its own.
- A credential value never appears in an answers document, a profile file, a process argument or a log. The provider flags carry variable names only.
- Setup writes no row that enables credential forwarding. Forwarding is set per workspace under the runtime contract.

Denial tests:

| Test name | Behaviour proven |
| --- | --- |
| `yes run leaves reach and credential forwarding off` | After `--yes`, the profile contains no reach row and no forwarding row. |
| `config file cannot enable reach` | A document whose `reach.option` is not `none` is refused with a typed error that names `reach.option`. |
| `refuses --prompts dangerous without --accept-dangerous-mode, and a document without acceptDangerousMode` | The flag form is refused with the usage code naming `--accept-dangerous-mode`, and a document whose `prompts` is `dangerous` is refused with a typed error that names `acceptDangerousMode`; nothing is written. |
| `declining dangerous mode at either step writes no grant` | Answering No to the first step, or typing anything but `full access everywhere`, keeps the previous answer and writes no grant file and no `fullAccessEverywhere: true` row. |
| `yes keeps safer and a root user is refused` | `--yes` alone writes `safer`; the dangerous answer is refused when the process runs as root, in the questions, the flags and a document, before anything is written. |
| `refuses a document that asks for the stock-home import, which shows its preview in a terminal first` | A document whose `importStockHome` is `true` is refused with a typed error that names the field. |
| `refuses a document that turns changes protection on, which only a terminal changes, and reads an absent answer as no` | A document whose `protectChanges` is `true` is refused with a typed error that names the field. |
| `stops a yes before it writes, naming how to finish, and a run at a terminal resumes it` | A yes whose standard output is not a terminal writes no protection record. |
| `config file with a removed key is refused` | A document that carries a removed key is refused with a typed error that names the removed keys and no value. |
| `config file carrying a credential value is refused` | A document with a credential value in any field is refused, and the value is not echoed. |
| `live key check sends the key to the provider origin only` | For every provider, the check's request goes to one origin, with redirects refused, and the key is in no URL, message or output; a redirect to another origin fails, and that origin receives nothing. |
| `--key-env carrying a key is refused` | A `--key-env` value that is not a variable name is refused with the usage code, and the value is not echoed. |
| `refuses a base URL with a user name, password, query or fragment, and a model that is not an id, without echoing either` | A document whose base URL carries a credential, a query or a fragment, or whose model is not a model id, is refused naming the field, and the value is not echoed. |
| `settles on the status alone: an endpoint that sends its headers and then holds the body does not keep the check waiting` | A non-DeepSeek check resolves on the response status while the body never ends. |
| `typed key is never printed` | The recorded screen of a run holds no part of the typed key, and no file under the home but `.credentials.yaml` holds it, for DeepSeek and for a pi-ai provider. |
| `default-profile run sends no analytics or upload` | A network fixture records no request to an analytics destination and no session-log upload in a default profile. |
| `default-profile model request carries no dsh_session_log` | A model request from a default profile has no `dsh_session_log` field. |
| `update-notice-off-at-first-start` | After `delorun setup privacy` answers No, and after `--yes --no-update-check`, the profile the first start composes has the `delorun-update-check` row with `enabled: false`, and the row mounts no check service. |

Acceptance tests:

- `setup states the telemetry statement and that both opt-ins are off`.
- `a fresh home asks only the phone question, and a phone Yes also asks about changes protection`.
- `a DeepSeek Harness home adds the import question; Later and Show what stays behind copy nothing and ask again`.
- `the port is asked only when 3080 is busy`.
- `a run without a terminal, and --phone, --import-dsh and --port, take their answers without questions`.
- `delorun setup <section> asks key, prompts, background, privacy, reach and profile in full`.
- `an interrupt at any question exits 130 and saves nothing`.
- `a record with a Quick or Full mode and no use case still reads`.
- `Ask less (like DeepSeek Harness) sets every prompt switch to its parity value`.
- `interactive and --yes runs write identical profile files`.
- `interrupted setup resumes without a repeated write`.
- `consent screen turns each upstream opt-in on alone and off again from the same screen`.
- `a way back returns to the previous question with the earlier answers kept`.
- `is asked after the phone question in the main flow and copies the chats before the profile is written`.
- `delorun setup privacy shows the note, turns the check off, and turns it on again by removing the row`.

<a id="decided-values"></a>
## Decided values

- The answers schema version is `5`; setup also reads versions 2, 3 and 4.
- The provider question starts on `deepseek-official` in a terminal, and `--yes` sets up no provider unless `--provider` names one.
- The use case defaults to `local`; a Yes to other devices sets `remote`, and only a `--config` document sets `automation`.
- The defaults are "Ask me first" prompts, background running on, port 3080, `none` for reach, off for the stock-home import, which the import section preselects as Yes when it is shown, as copying only reads the stock home, and on for the release check.
- Each provider's key variable is the one [Model providers](#model-providers) lists; DeepSeek's is `DEEPSEEK_API_KEY`.
- The reach options of setup are `none`, `tailscale-private`, `tailscale-funnel` and `self-hosted-relay`.
- The feedback send is not an answer, and setup states it.
