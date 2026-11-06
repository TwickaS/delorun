---
description: "Contract C11: the questions setup asks, the answer schema, the profile writes each answer produces, the --yes and --config forms, and the statements setup makes."
---

# Contract C11: setup answers

English | [中文](c11-setup-answers.zh.md)

<a id="summary"></a>
## Summary

Setup answers are the fixed questions that `delorun setup` asks on a new home, the schema that stores each answer, the profile writes each answer produces, and the `--yes` and `--config` forms that give the same answers without a terminal. The studio onboarding and consent screens use the same answers for upstream's two opt-ins. Delo has no telemetry of its own, and setup says so before it asks about upstream's opt-ins. Both opt-ins default to off.

<a id="contents"></a>
## Contents

- [Summary](#summary)
- [Contract](#contract)
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

<a id="questions"></a>
### Questions

Setup asks these questions, in this order. The default applies when the person accepts it, and the `--yes` form uses the default for each question it does not otherwise set.

| Question | Answer | Default |
| --- | --- | --- |
| Model provider and key | A provider id that upstream ships, and a credential. | `deepseek-official`, with the credential entered at the prompt. |
| Runtime | `native`, or `docker` with a shape and a resource preset. | `native` |
| Studio additions | On or off. Off is the stock look. | On |
| Reach from anywhere | None, Tailscale private, Tailscale Funnel or a self-hosted relay. | None |
| Identity factor, when reach is on | A passkey, an OpenID Connect sign-in, or tailnet identity for tailnet-private reach. | None when reach is none. Required for each public reach option. |
| Set up other models | Yes or no. Yes sets the studio onboarding flag that recommends provider plugins. | No |
| Upstream desktop analytics | On or off. | Off |
| DeepSeek session-log upload | On or off. | Off |
| Import a stock DeepSeek Harness home | Yes or no. Offered only when a stock home exists at `~/.dsh`. | No |

The Delo relay is not among the reach options of setup. Setup reads the stock home only to copy from it, and never modifies it.

<a id="answer-schema"></a>
### Answer schema

An answers document is a JSON object with the fields below. The same schema is used by the interactive setup, which fills it in, and by `--config`, which reads it.

```json
{
  "schemaVersion": 1,
  "modelProvider": { "id": "deepseek-official", "credential": { "source": "environment", "name": "DEEPSEEK_API_KEY" } },
  "studioAdditions": true,
  "runtime": { "kind": "native" },
  "reach": { "option": "none", "identityFactor": null },
  "helpSetUpModels": false,
  "sessionLogUpload": false,
  "desktopAnalytics": false,
  "importStockHome": false
}
```

| Field | Type and values | Default | Rule |
| --- | --- | --- | --- |
| `schemaVersion` | Integer `1`. | `1` | Setup refuses any other value. |
| `modelProvider.id` | A provider id that upstream ships. | `deepseek-official` | Setup refuses an id that upstream does not ship. |
| `modelProvider.credential` | `{ "source": "prompt" }` or `{ "source": "environment", "name": "<variable>" }`. | `{ "source": "prompt" }` | `prompt` is accepted only in the interactive form. |
| `studioAdditions` | Boolean. | `true` | `false` selects the stock look. |
| `runtime` | `{ "kind": "native" }`, or `{ "kind": "docker", "shape": "S2" or "S3", "preset": "small", "balanced", "large" or "advanced" }`. | `{ "kind": "native" }` | Docker shapes and presets are those of the Docker runtime contract. |
| `reach.option` | `none`, `tailscale-private`, `tailscale-funnel` or `self-hosted-relay`. | `none` | Any value other than `none` is accepted only in the interactive form. |
| `reach.identityFactor` | `passkey`, `oidc`, `tailnet` or `null`. | `null` | `null` when the option is `none`. `passkey` or `oidc` for `tailscale-funnel` and `self-hosted-relay`. `passkey`, `oidc` or `tailnet` for `tailscale-private`. |
| `helpSetUpModels` | Boolean. | `false` | Sets the onboarding flag. |
| `sessionLogUpload` | Boolean. | `false` | Maps to upstream's session-log opt-in. |
| `desktopAnalytics` | Boolean. | `false` | Maps to upstream's desktop analytics opt-in. |
| `importStockHome` | Boolean. | `false` | Starts the import of a stock home; it is an action, not a profile write. |

The answers document never contains a credential value. A credential is either entered at the prompt and stored through upstream's credential store, or read from the environment variable named by `credential.name`.

<a id="profile-writes"></a>
### Profile writes

Each answer produces the writes below. Config writes go to the per-profile `cordis.patch.yml` of the profile the answer applies to, and upstream applies that file after the bundles.

| Answer | Write | Target |
| --- | --- | --- |
| `modelProvider` | Upstream's saved model selection, through upstream's settings. The credential goes to upstream's credential store. | The `default` profile's settings. |
| `studioAdditions` | The stock-look switch of `@delo/bundle-studio`. | The `default` profile. |
| `runtime` | The runtime rows of the Docker runtime contract. `native` writes none. | The `default` profile. |
| `reach.option` | The reach rows of the reach contracts. `none` writes none. | The `default` profile. Written only in the interactive form. |
| `reach.identityFactor` | An enrolment request for the reach address. No config row. | Home-auth state, under the identity contracts. |
| `helpSetUpModels` | The studio onboarding flag. | The `default` profile. |
| `sessionLogUpload` | `config.enabled` of the `session-log-deepseek` row. | The `default` profile. |
| `desktopAnalytics` | `config.enabled` of the `product-analytics` row. | The `desktop` profile, which setup creates when it does not exist. |
| `importStockHome` | The import of a stock home under the archive contract. | Not a profile write. |

Upstream's session-telemetry row `session-telemetry-otel` is not an answer. It sends a session-log prefix only after the person submits feedback, and setup states that behaviour in the statements below. The feedback dialog shows the exact payload, the session-log prefix included, and its destination before the person sends it.

<a id="yes-and-config-forms"></a>
### The --yes and --config forms

`--yes` accepts every default. It applies no answer other than the defaults, and it reads the model credential from the environment variable that `credential.name` names, which defaults to `DEEPSEEK_API_KEY`. When that variable is unset, setup stops with a typed error that names the variable.

`--config <file>` reads an answers document with the schema above, and applies its answers under the same rules as `--yes`. A document whose `reach.option` is not `none`, or whose `sessionLogUpload` or `desktopAnalytics` is `true`, is refused with a typed error that names the field. A document that carries a credential value, in any field, is refused without echoing that value.

For identical answers, the interactive form and the `--yes` or `--config` form write identical profile files.

Setup resumes an interrupted run at the first step that did not finish. A step that runs again writes the same values.

<a id="statements"></a>
### Statements

Setup shows these statements before it asks about upstream's opt-ins, and repeats them on the review screen.

- Delo has no telemetry of its own.
- Upstream's desktop analytics and DeepSeek's session-log upload are off unless you turn them on.
- Upstream's feedback send includes a session-log prefix, and it happens only when you send feedback.
- Recovery uses the recovery kit and the home's terminal when an identity factor is enrolled, and the home's terminal only when none is enrolled.
- Docker group membership is root-equivalent, and setup recommends rootless Docker.
- A Docker option is labelled as not enforced when the sandbox dialect of the system cannot enforce the confinement rule of the runtime contract.

<a id="consumers"></a>
## Consumers

- `delo/apps/cli/src/setup/`: the setup screen and its `--yes` and `--config` forms.
- `delo/packages/bundle-local`: the upstream opt-in rows and their consent screen in the studio.
- `delo/packages/plugin-onboarding/`: the studio onboarding flag.
- `delo/packages/contract-setup-answers/`: the answer types, the defaults and the profile row names.

<a id="compatibility"></a>
## Compatibility

The answers schema is versioned by `schemaVersion`, which is `1`. A change that adds a question with a safe default keeps the version when an older reader that ignores the new field writes the same profile. A change that alters the meaning of an existing answer, or that removes a field, increments the version. Setup refuses an answers document whose version it does not know.

A new upstream opt-in is added as a question with a default of off, in the same change that adds its profile row to the mapping.

<a id="security"></a>
## Security

Requirements:

- `--yes` and `--config` never enable reach, credential forwarding, upstream's desktop analytics or upstream's session-log upload.
- Upstream's opt-ins are available and off by default. They take effect only when the person turns them on in setup or on the consent screen.
- Delo sends no telemetry of its own.
- A credential value never appears in an answers document, a profile file, a process argument or a log.
- Setup writes no row that enables credential forwarding. Forwarding is set per workspace under the runtime contract.

Denial tests:

| Test name | Behaviour proven |
| --- | --- |
| `yes run leaves reach and credential forwarding off` | After `--yes`, the profile contains no reach row and no forwarding row. |
| `config file cannot enable reach` | A document whose `reach.option` is not `none` is refused with a typed error that names `reach.option`. |
| `config file cannot enable upstream opt-ins` | A document whose `sessionLogUpload` or `desktopAnalytics` is `true` is refused with a typed error that names the field. |
| `config file carrying a credential value is refused` | A document with a credential value in any field is refused, and the value is not echoed. |
| `default-profile run sends no analytics or upload` | A network fixture records no request to an analytics destination and no session-log upload in a default profile. |
| `default-profile model request carries no dsh_session_log` | A model request from a default profile has no `dsh_session_log` field. |

Acceptance tests:

- `setup states the telemetry statement and that both opt-ins default to No`.
- `interactive and --yes runs write identical profile files`.
- `interrupted setup resumes without a repeated write`.
- `consent screen turns each upstream opt-in on alone and off again from the same screen`.
- `Docker option carries the not-enforced label on a dialect that cannot enforce the confinement rule`.

<a id="decided-values"></a>
## Decided values

- The answers schema version is `1`.
- The defaults are `deepseek-official` for the provider, `native` for the runtime, on for studio additions, `none` for reach, and off for the onboarding flag, both upstream opt-ins and the stock-home import.
- The default credential variable is `DEEPSEEK_API_KEY`.
- The reach options of setup are `none`, `tailscale-private`, `tailscale-funnel` and `self-hosted-relay`.
- The feedback send is not an answer, and setup states it.
