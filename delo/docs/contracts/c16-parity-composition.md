---
description: "Contract C16: the parity composition that replays upstream's recorded scenarios unchanged, its switch registry, how the replay lane selects it, the pass rule and the switch sweep."
---

# Contract C16: parity composition

English | [中文](c16-parity-composition.zh.md)

<a id="summary"></a>
## Summary

The parity composition is the configuration under which Delo replays upstream's recorded scenarios at the base tag `dsh-v0.2.2-rc.1` and reproduces their expected output byte for byte. It is Delo's runtime with the studio bundle, which the studio packages deliver, switched off, every model-visible Delo change switched off, and each listed Delo default set to its upstream value wherever the replay exercises it. Delo's default composition is not held to this contract; Delo's own recorded scenarios prove it. This page defines the composition, the switch registry that makes each model-visible change switchable, how the replay lane selects the composition, the pass rule and the switch sweep.

<a id="status"></a>
## Status

The parity composition, the overlay, the registry and the replay lane are built; four registry defaults and one changed default are not applied by any shipped profile.

- **Built and reached:** the overlay, which only the replay lane selects through `DSH_SNAPSHOT_PATCH`; the registry `PARITY_SWITCHES`; and the CLI profile's rows for the consent and guard switches, the update gate, the protected home and one-time launch tokens, each with its switch on.
- **Not applied:** no shipped row sets `preset_inspect`, `plugin_manager_read_exemption`, `profile_history` or `container_denial_marker`, so the CLI profile runs each at its Config default, the parity value, off, although the registry's default is on; and no shipped row selects `ptc` as the onboarding preset, so the CLI profile keeps upstream's `standard`.

<a id="contents"></a>
## Contents

- [Summary](#summary)
- [Status](#status)
- [Contract](#contract)
  - [Composition](#composition)
  - [Changed defaults](#changed-defaults)
  - [Switch registry](#switch-registry)
  - [Replay lane](#replay-lane)
  - [Switch sweep and pass rule](#switch-sweep-and-pass-rule)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)
- [Decided values](#decided-values)

<a id="contract"></a>
## Contract

<a id="composition"></a>
### Composition

The parity composition consists of the following parts.

- Upstream's profiles, bundles and scenario layers at the base tag, unchanged. A scenario's profile and composition come from its `snapshot.yml`. Its replay layers apply as upstream applies them: the composition's `cordis.snapshot.yml`, the base composition's `model.cordis.yml` and the scenario's `runtime.cordis.yml` where present.
- `@delo/bundle-local`, restated by the parity overlay in its parity form. `@delo/bundle-studio` is not mounted: the switch `studio_additions` stays at its Config default, off, which is the stock look. `@delo/bundle-headless` is not mounted either: the parity composition keeps upstream's `headless` profile as it is, without Delo's guards.
- Every switch in the [switch registry](#switch-registry) at its parity value. A switch that is off registers no model-visible contribution: no tool, tool schema, tool description, tool result text, system prompt context or runtime context.
- Each changed default in the [table below](#changed-defaults) at its parity value.

The parity overlay is a Cordis patch file, `delo/apps/tools/src/parity/composition/parity.overlay.yml`, that sets the switches and defaults above. The replay lane passes it to every snapshot process as described under [replay lane](#replay-lane).

<a id="changed-defaults"></a>
### Changed defaults

Delo changes the following upstream defaults on purpose. The parity composition sets each one to its parity value. Where the replay does not exercise a default, the parity composition keeps Delo's value, so the row states that the replay does not need the change reversed.

| Default | Delo default composition | Parity composition | Reason for the parity value |
| --- | --- | --- | --- |
| Studio additions (`studio_additions`) | On, with one switch for the stock look | Off, which is the stock look | Recorded web scenarios compare upstream's interface output. |
| Agent preset selected in studio onboarding (`agent-preset-registry.config.default`) | `ptc` in the registry; no shipped row sets it, so the CLI profile keeps `standard` | `standard`, upstream's composed default | A scenario that does not name a preset runs on the composed default, so the replay needs upstream's value. |
| Per-workspace permission preset (`permission_defaults`) | A new workspace starts on `workspace-write`. Selecting `danger-full-access` for a workspace needs one consent for that workspace. | Upstream's composed defaults (`sandbox-policy.config.mode` `workspace-write`, `approval.config.policy` `ask`) with no consent requirement | The resolved permission policy reaches each model request through the system prompt context, and the recorded scenario `permission-policy-context` replays it. |
| Desktop analytics (`product-analytics.config.enabled`) | `false` | `false`, Delo's value kept | Not needed: the replay mounts no desktop Host, because the `sdk-desktop` composition runs the `sdk` profile. |
| DeepSeek session-log upload (`session-log-deepseek.config.enabled`) | `false` | `true`, upstream's value | Recorded scenarios ran with the upload on unless their replay layer sets it to `false`; the overlay precedes those layers. |
| `web_fetch` guard (`fetch_guard`) | On | Off | Recorded fetch scenarios call loopback fixtures, which the guard refuses. |
| `preset_inspect` (`preset_inspect`) | On in the registry; no shipped row sets it, so the CLI profile runs it off | Off | The tool is model-visible and absent from the base tag. |
| Doctor (`doctor`) | On, and switchable | Off | The doctor is a command the person runs, not a model-visible tool; it is absent from the base tag. |
| Remote access (`reach`) | On: the reach service mounts with every option off until the person turns one on | Off: neither `@delo/home-auth` nor the reach service mounts | Recorded scenarios run on upstream's own authenticator and open no reach listener. |

DeepSeek session-log upload is off in every profile that mounts `@delo/bundle-local`: `delorun`'s CLI profile, and any other profile that adds the bundle. A profile that does not mount it keeps the plugin's own default, on: upstream's bare `dsh` launcher on the `web` profile, which Delo also ships, still uploads the session log, and the recorded-session replay keeps upstream's value for the corpora whose replay layer does not turn it off. The difference is the entry point, not a switch — Delo writes the row from a bundle it delivers, and edits no upstream default for a profile it does not run.

<a id="switch-registry"></a>
### Switch registry

Each model-visible Delo change and each feature switch registers exactly one entry in the switch registry. An entry names the switch `id`, the package or upstream edit that registers it, its default value, its parity value, the scenario that proves it, and the model-visible contributions it switches. A feature switch, marked `featureSwitch: true`, switches no model-visible contribution; the doctor is one. The registry is the constant `PARITY_SWITCHES` in `@delo/contract-parity-composition`, and its version is `PARITY_REGISTRY_VERSION`. A switch id is lower snake case and never reused.

The registry has these entries.

| Switch id | Registered by | Default | Parity | Model-visible contributions it switches |
| --- | --- | --- | --- | --- |
| `studio_additions` | `@delo/plugin-theme`, which `@delo/bundle-studio` mounts with the switch on | On | Off | None: a feature switch for the theme, sidebar, chat states, settings layout and onboarding. Off is the stock look. |
| `main_chat` | `@delo/plugin-main-chat`, an experimental plugin no Delo profile mounts | On wherever a row mounts it | Off | The main chat's tools, including its write-class tools, its guard and its reports. |
| `permission_defaults` | `@delo/plugin-permission-defaults` | On | Off | The workspace default preset and the one-consent requirement for full access. |
| `fetch_guard` | `@delo/plugin-fetch-guard` | On | Off | Refusal of loopback, link-local and private targets by `web_fetch` and the HTTP fetch provider, with a typed reason. |
| `preset_inspect` | Delo's edit of upstream's preset tools | On | Off | The `preset_inspect` tool. |
| `doctor` | `packages/boot/doctor`, launched by `apps/cli` | On | Off | None: a feature switch for the doctor command. |
| `reach` | `@delo/reach` | On | Off | None: a feature switch for remote access over the person's tailnet; each option stays off until the person turns it on. |
| `plugin_manager_read_exemption` | Delo's edit of upstream's `plugin_manager` tool | On | Off | The escalation exemption for the read actions `list_plugins`, `list_bundles`, `list_version_exemptions`, `history` and `read_config`, and the tool description that states it. |
| `profile_history` | Delo's edit of upstream's `plugin_manager` tool | On | Off | The actions `history`, `read_config`, `configure`, `undo` and `restore`, and the audit of plugins, builds and exemptions that `undo` and `restore` bring back. |
| `scheduled_task_consent` | Delo's edit of upstream's schedule tools | On | Off | The consent for `schedule_create` and `schedule_edit`, which names the recurrence, the target session and its permission preset. |
| `instruction_layer_consent` | Delo's approval for instruction-layer files | On | Off | The approval for a model-authored write to a skill, a preset or an `AGENTS.md`, which names the effect and shows the diff. |
| `mcp_add_consent` | Delo's MCP server add flow | On | Off | The consent that names the command an added MCP server will run. |
| `container_denial_marker` | Delo's edit of upstream's container denial reporting | On | Off | The environment denial marker on denials inside a container. |
| `update_turn_refusal` | `@delo/bundle-local`, its `delo-update-gate` row | On | Off | The refusal of the first step of every new turn with `UPDATE_PENDING` while `delorun`'s chat gate is held ([C19](c19-home-process.md)), so the turn ends with that message and no model request; and, with `holdUntilChecked`, the wait of the first step of every turn until `delorun` has checked the booted Host's rows and services, for at most `checkWaitSeconds`, after which the turn ends with `START_CHECK_PENDING`. |
| `update_check` | `@delo/bundle-local`, its `delo-update-check` row | On | Off | None: a feature switch for the update check, the request for the release channel's newest release that stock DSH does not make ([C3](c03-update-report.md#update-check)). Off, the row provides no service and registers no route, and no check runs. |
| `sandbox_protected_reads` | Delo's edit of upstream's `glob`, `grep` and `present` tools | On: `@delo/bundle-local`'s `sandbox` row sets `protectedHome` | Off: the parity overlay leaves the `sandbox` row to upstream, which sets no `protectedHome` | Whether the search tools and `present` refuse the sandbox provider's protected reads: a search rooted under the Delo home is refused and its paths are left out of a wider search, and a file under the home is not presented, as `read` and `read_image` already refuse them. |
| `one_time_launch_tokens` | Delo's edit of upstream's connection, whose `connection` row `@delo/bundle-local` sets with the switch on | On | Off: the parity overlay leaves the `connection` row to upstream's web bundle | None: a feature switch for one-time studio sign-in links ([C4](c04-admission.md#launch-tokens)). Off is upstream's reusable launch token. |

A registry entry's `defaultValue` is the value the registry gives Delo's default composition, and its `parityValue` applies in the parity composition. `permission_defaults`, `fetch_guard`, `instruction_layer_consent` and `update_turn_refusal` apply in the profile `delorun headless` boots too, with the same value as in the CLI profile, through the rows of `@delo/bundle-headless` ([C19](c19-home-process.md#host-invariants)); a guard that asks a person refuses there, because the profile composes no approval answerer. The headless profile is not a replay profile, so each of the four stays at its parity value in the parity composition. The CLI profile applies the `defaultValue` of every built switch except `preset_inspect`, `plugin_manager_read_exemption`, `profile_history` and `container_denial_marker`, which no shipped row sets, so each runs its Config default, off. A built switch's field is either a boolean Config field, whose schema default is the parity value, or a presence field: a Config key whose JSDoc names the switch and which Delo's default composition sets on the module's row and the parity composition does not. A presence switch is on by default and off at parity, and `parity-switches` with its specs checks both compositions' rows. Configuration sets each switch value. A switch registered by an upstream edit is a hook or configuration field added upstream, and the behaviour it controls lives under `delo/`.

<a id="replay-lane"></a>
### Replay lane

The replay lane selects the parity composition with the environment variable `DSH_SNAPSHOT_PATCH`, whose value is the path of the parity overlay. Every snapshot adapter listed in `snapshotAdapters` in `scripts/session-snapshot-corpus.corpus.ts` reads the variable and passes the overlay as a `--patch` argument. The overlay follows the first patch of each process, which is the root configuration file, and precedes every scenario layer, so a scenario's own replay layer keeps the last word.

The check `parity-replay` runs `pnpm run test:snapshot` with that variable set, which covers the session, SDK and ACP replay and the corpus check of web scenarios. The full web replay is a separate run, `DSH_SNAPSHOT=replay DSH_SNAPSHOT_PATCH=delo/apps/tools/src/parity/composition/parity.overlay.yml pnpm run test:web:built`, which runs at each green-base exit and is not part of `parity-replay`. The lane edits no `snapshot.yml`, no replay layer, no fixture and no expected output. An adapter that receives the variable in `DSH_SNAPSHOT=record` or `DSH_SNAPSHOT=refresh` mode fails before it starts a process.

<a id="switch-sweep-and-pass-rule"></a>
### Switch sweep and pass rule

Each registry entry has one switch-on scenario in Delo's snapshot tree. Its directory is `snapshots/<profile>/delo-<id>`, where `<id>` is the switch id with underscores replaced by hyphens, and its `runtime.cordis.yml` sets only that one switch to its non-parity value, plus the scenario-local `agent-default-model` pin that selects the corpus model `deepseek-v4-flash`. A Web switch-on scenario has no `runtime.cordis.yml`; its e2e driver under `apps/web/tests` turns the switch on with `launchWebScaffold`'s option and, on replay, selects the same model through the agent default model. The sweep runs each switch-on scenario under the parity overlay, within the coverage that the [replay lane](#replay-lane) defines, so the switch under test is the only behavioural difference from the parity composition.

The check `parity-switches` runs two parts. The static part scans `delo/` for `systemPrompt.context` contributions and for tool registrations and tool schema changes. A match that belongs to no registry entry fails the check. The replay part runs the switch-on scenarios described above.

A parity run passes when `pnpm run test:snapshot` with the overlay exits 0 for every session, SDK and ACP scenario in the base tag's corpus, the corpus check of web scenarios passes, and `git diff --exit-code snapshots/` shows no change afterwards. Delo's default composition passes when Delo's own recorded scenarios pass with no overlay.

<a id="consumers"></a>
## Consumers

- `delo/packages/contract-parity-composition/`: the registry, its version and the switch types.
- `delo/apps/tools/src/parity/composition/`: the parity overlay, the replay lane, the static scan and the switch sweep.
- `delo/apps/tools/src/run-checks.ts`: the `parity-replay` and `parity-switches` checks.
- `delo/apps/tools/src/parity/release/`: the release tooling delivers the parity run on built release artifacts.
- `@delo/plugin-theme`, `@delo/plugin-main-chat`, `@delo/plugin-permission-defaults` and `@delo/plugin-fetch-guard`: packages that register switches; `@delo/bundle-studio` sets `studio_additions` in Delo's default composition, and `@delo/bundle-local`, which Delo's CLI profiles add, registers its own. `@delo/bundle-headless` mounts the switches' consent and guard plugins in the `headless` profile and registers none.
- `packages/boot/doctor`, launched by `apps/cli`: the doctor's registration.
- Upstream's `vitest.snapshot.config.ts`, the snapshot adapters listed in `snapshotAdapters`, and the `snapshot.yml` and replay layer files of each scenario, which the lane reads without changing them.

<a id="compatibility"></a>
## Compatibility

The registry is additive. A change that adds a switch adds its entry, its parity value and its switch-on scenario in one change, and the switch sweep fails an entry without a scenario. Removing an entry, or reusing an id, is a registry change that increments `PARITY_REGISTRY_VERSION`.

Changing a parity value changes what the replay asserts, so it is made together with the replay pass that proves it. Moving the base tag reruns `parity-replay` and the full web replay on the new base tag's scenarios, because upstream's expected output is the base tag's expected output.

The parity composition is a test composition. Shipped profiles do not select it, and it has no compatibility promise to a person's configuration.

<a id="security"></a>
## Security

Requirements:

- The parity overlay loads only when the replay lane sets `DSH_SNAPSHOT_PATCH`. No shipped profile, no person's configuration and no command-line option selects it.
- In the parity composition, `permission_defaults`, `fetch_guard`, `scheduled_task_consent`, `instruction_layer_consent`, `mcp_add_consent`, `update_turn_refusal` and `container_denial_marker` are off, and their protections are absent there.
- The composition a person runs mounts the consent plugins on: `@delo/bundle-local`, the one Delo layer a CLI profile adds, inserts the rows `delo-instruction-consent`, `delo-mcp-consent`, `delo-permission-defaults`, `delo-schedule-consent`, `delo-fetch-guard` and `delo-update-gate` with their switch on, and the parity overlay restates those same six rows disabled, so the parity composition mounts none of them. It also inserts `delo-update-check` with the update check on, and the parity overlay restates it disabled, so the parity composition makes no request for a newer release. `container_denial_marker` is a field of upstream's `sandbox-policy` row, which no shipped layer sets, so each composition runs its Config default, off.
- The shipped sandbox row protects the Delo home: `@delo/bundle-local` sets its `protectedHome` to the harness home, which is the Delo home for every runtime process, with C1's read exemptions, so a confined command cannot read the consent stores under `<home>/secrets`; `delorun start` adds that profile's channel sockets as `deniedSockets`. The parity overlay leaves the row to upstream's composition, so the replay runs upstream's confinement.
- `plugin_manager_read_exemption` exempts only the five read actions. Every write action still requires the `danger-full-access` escalation.
- A container denial is never answered with escalation guidance, and a policy denial from `bwrap` is never labelled `environment`.
- A model-authored write to an instruction-layer file, a scheduled task delivering into a full-access workspace and an added MCP server each wait for their consent before any effect.

Denial tests:

| Test name | Behaviour proven |
| --- | --- |
| `parity-switches refuses an unregistered model-visible contribution` | A fixture Delo plugin that contributes to `systemPrompt.context` without a registry entry fails the static scan. |
| `parity replay refuses a model-visible switch left on` | A fixture that leaves a model-visible switch on in the parity composition fails the replay lane. |
| `parity replay refuses record and refresh modes` | An adapter that receives `DSH_SNAPSHOT_PATCH` in record or refresh mode fails before it starts a process and writes no fixture. |
| `fetch guard refuses loopback, link-local and private targets` | `web_fetch` to `127.0.0.1`, `169.254.169.254` and `fe80::1` is refused in the default composition with a typed reason that the model reads. |
| `scheduled task delivery into a full-access workspace is refused without consent` | Delivery is refused with a typed reason, the task shows as paused, and no turn runs. |
| `instruction-layer write without approval changes nothing` | A model-authored write to a skill, a preset or an `AGENTS.md` leaves the file unchanged until the approval naming the effect and the diff is granted. |
| `MCP server add without consent starts no command` | The command named in the consent is not started before the consent is granted. |
| `plugin_manager write actions keep the escalation under the read exemption` | `set_plugin`, `set_bundle`, `install_bundle`, `remove_bundle`, `set_version_exemption`, `undo` and `restore` each require the `danger-full-access` escalation. |
| `plugin_manager history records no version` | `history` lists versions on the exempt path and records none. |
| `plugin_manager read_config withholds values of a non-native Config` | `read_config` returns no value of a Config that is not a native schema. |
| `container denial carries no escalation guidance` | A denial inside a container returns the environment marker and no escalation guidance in every permission mode of the default composition. |
| `bwrap policy denial is never labelled environment` | A `Read-only file system` denial from `bwrap` is not labelled `environment`. |
| `parity overlay is not selected by a person's configuration` | A shipped profile started with the overlay file present and without `DSH_SNAPSHOT_PATCH` does not load the overlay. |
| `update gate refuses a new turn while held` | With a source attached to the `deloTurnGate` service held, a new turn in the default composition ends with `UPDATE_PENDING` before any model request, and a turn that was already running takes its next step. |
| `confined command cannot read the home's secrets` | Under the sandbox row the default composition ships, a workspace command cannot read a canary under `<home>/secrets`, while the same command unconfined reads it and a file under a read exemption stays readable. |

Replay proofs, which show that a switch off restores upstream's output and are not denial tests:

- `parity replay passes the base tag's scenarios with every switch off`.
- `fetch guard off replays the base tag's fetch scenarios unchanged`.

<a id="decided-values"></a>
## Decided values

- The base tag is `dsh-v0.2.2-rc.1`.
- The registry version is `1`.
- The replay lane variable is `DSH_SNAPSHOT_PATCH`, and the overlay path is `delo/apps/tools/src/parity/composition/parity.overlay.yml`.
- A switch-on scenario directory is `snapshots/<profile>/delo-<id>`.
- The parity values are those in the [changed defaults](#changed-defaults) table and the [switch registry](#switch-registry) table.
- Session-log upload is on in the parity composition, and desktop analytics stays off in every composition.
