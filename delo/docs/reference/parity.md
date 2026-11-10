# Parity checklist

English | [中文](parity.zh.md)

The parity checklist records, for each stock DeepSeek Harness (DSH) area that Delo is compared against and for each deliberate difference, the status of that area in this tree and one piece of evidence. Every row names its baseline, the recorded upstream tag `dsh-v0.2.2-rc.1`, which the [parity composition](../contracts/c16-parity-composition.md) replays. The page covers the areas below, the switches and changed defaults that the parity composition contract lists, and the differences that the [comparison page](../guide/delo-vs-stock.md) names. It does not inventory every stock feature.

## How rows are judged

The status column states what this tree does. `built` means the change is in the tree: the row names its switch ID, or, for a Delo change that has no switch, says `no switch` and names its ledger entry. `planned` means the change is not in the tree: the row names the switch ID and work package from the registry or, where the registry has no entry, the C16 changed default or the contract that defines it. `stock` means upstream's behaviour at the baseline is unchanged in the area.

Each row gives one evidence. A check name, such as `parity-switches`, runs `node_modules/.bin/tsx delo/apps/tools/src/parity/composition/check-parity-switches.ts`, which reads the switch registry, the switch fields and the parity overlay. A spec path names a test file that asserts the row. An entry that begins with Manual check: names the source lines that a reviewer reads to confirm the row.

Four built switches have a switch-on scenario that is pending recording. `parity-switches` reports each one as pending, not as passing, so this page claims no replay result for them.

## Liveshare

Liveshare is upstream's experimental share feature. This tree keeps it with one Delo change.

| Item | Baseline and this tree | Status | Evidence |
| --- | --- | --- | --- |
| Owner surfaces refused to share viewers | `dsh-v0.2.2-rc.1`: a share viewer is refused owner surfaces, such as `pluginManager/listPlugins`; this tree keeps that list | stock | `packages/experimental/liveshare/tests/viewer-access-policy.spec.ts` |
| Plugin-manager history, restore and undo | `dsh-v0.2.2-rc.1`: the endpoint classification lacks `pluginManager/history`, `pluginManager/restore` and `pluginManager/undo`; this tree classifies each as `owner-only` in `packages/experimental/liveshare/src/endpoint-classification.ts` at lines 142, 152 and 156 | built: no switch; `security` ledger entry | Manual check: the three lines are absent at `dsh-v0.2.2-rc.1` and present in the tree, and the ledger entry records the lead's verdict. |

## Desktop app payload

The desktop app's Python, Node and Office payload has no Delo change in this tree.

| Item | Baseline and this tree | Status | Evidence |
| --- | --- | --- | --- |
| Python runtime | `dsh-v0.2.2-rc.1`: the desktop payload carries a Python interpreter and rejects a payload that lacks node and pnpm; this tree has no Delo change under `apps/desktop` | stock | `apps/desktop/tests/primary-runtime-preparation.spec.ts` |
| Node runtime | `dsh-v0.2.2-rc.1`: the prepared runtime includes `bin/node` and one pnpm distribution; this tree has no Delo change under `apps/desktop` | stock | `apps/desktop/tests/runtime-preparation.spec.ts` |
| Office engine | `dsh-v0.2.2-rc.1`: each platform's payload keeps only its selected Office engine; this tree has no Delo change under `apps/desktop` | stock | `apps/desktop/tests/runtime-file-policy.spec.ts` |

## SDK runtime selection

Delo keeps upstream's SDK and its documented runtime selection.

| Item | Baseline and this tree | Status | Evidence |
| --- | --- | --- | --- |
| Runtime selection | `dsh-v0.2.2-rc.1`: the Python SDK starts the bundled `dsh --profile sdk` runtime unless the caller selects another `dsh` executable or profile ([Python README](../../../python/README.md)); this tree has no Delo change in `python/` or `packages/sdk/` | stock | `python/sdk/tests/test_bundled_runtime.py` |

## Deliberate differences

Each difference below is one that Delo's documents name or that C16 lists. The rows are grouped by topic.

### Home and account

| Item | Baseline and this tree | Status | Evidence |
| --- | --- | --- | --- |
| Home directory | `dsh-v0.2.2-rc.1`: the home is `~/.dsh`, named by `DSH_HOME_DIR_NAME` in `packages/util/home-paths/src/index.ts` at line 12; this tree has no `~/.delo` resolver, and `delo/packages/contract-home-layout/src/index.ts` at line 15 names `~/.delo` only as a contract constant | planned: no switch ID or work package; contract [C1](../contracts/c01-home-layout.md) | Manual check: both lines match this description, and no code under `packages/` or `apps/` reads `.delo`. |
| DeepSeek account and Platform | `dsh-v0.2.2-rc.1`: `packages/credentials/deepseek-account`, `packages/credentials/deepseek-account-platform` and `packages/llm/llm-deepseek-account` are in the tree. This tree's Delo CLI profiles compose `deepseek-account` disabled, where [`@delo/bundle-local`](../../packages/bundle-local/README.md) sets it as a C16 changed default, so no Platform sign-in, Usage or Top-up page is served and `llm-deepseek-account` stays inert; the parity composition keeps upstream's row, which the overlay leaves out | built: C16 changed default, no switch ID | `delo/packages/bundle-local/tests/composition.spec.ts` (no enabled `deepseek-account` row) |

### Permissions

| Item | Baseline and this tree | Status | Evidence |
| --- | --- | --- | --- |
| Full access consent per workspace | `dsh-v0.2.2-rc.1`: full access needs no consent, as C16's parity column states; this tree has no per-workspace consent | planned: `permission_defaults` (WP2.13) | `parity-switches` |
| New workspace default | `dsh-v0.2.2-rc.1` and this tree: a new workspace starts on `workspace-write`, and the approval policy is `ask` unless the mode is `danger-full-access` (`packages/bundle/base/cordis.patch.yml` at lines 246 and 262) | stock | Manual check: lines 246 and 262 set those defaults, and the file has no ledger entry. |
| sdk-minimal sandbox mode | `dsh-v0.2.2-rc.1` and this tree: the `sdk-minimal` profile sets `sandbox-policy` mode `danger-full-access` (`packages/bundle/sdk-minimal/cordis.patch.yml` at line 73) | stock | Manual check: line 73 sets that mode, and the file has no ledger entry. |

### Model-visible tools

| Item | Baseline and this tree | Status | Evidence |
| --- | --- | --- | --- |
| `preset_inspect` | `dsh-v0.2.2-rc.1`: no `preset_inspect` tool. This tree registers it only when `presetInspect` is on, and the switch defaults to off. The shipped Standard, PTC and Cordis presets mount the tool row without the switch, so no shipped preset in this tree lists the tool | built: `preset_inspect` | `packages/preset/agent-preset-registry/tests/tools.spec.ts` |
| Only new model-visible Delo tool | `dsh-v0.2.2-rc.1`: no `preset_inspect` tool. In this tree, `preset_inspect` is the only tool with a new name among Delo's registrations; the `plugin_manager` registration is edited, not added | built: `preset_inspect` | Manual check: `git diff --unified=0 dsh-v0.2.2-rc.1 -- packages apps scripts delo` adds one tool registration with a new name, `preset_inspect`, in `packages/preset/agent-preset-registry/src/tools.ts`. |

### Data sharing

| Item | Baseline and this tree | Status | Evidence |
| --- | --- | --- | --- |
| Desktop analytics, upstream's default | `dsh-v0.2.2-rc.1` and this tree's upstream profiles: on by default. The `product-analytics` config defaults `enabled` to `true` in `packages/client/product-analytics/src/index.ts` at line 36, and the desktop profile sets it to `true` in `packages/bundle/web-app/cordis.patch.yml` at line 53. The desktop shell's own flag starts `false` until the Host policy arrives (`apps/desktop/src/main.ts` at line 480) | stock | Manual check: the three lines match this description, and none of the files has a ledger entry. |
| Desktop analytics, Delo's default | `dsh-v0.2.2-rc.1`: on. This tree: off in Delo's CLI profiles, where [`@delo/bundle-local`](../../packages/bundle-local/README.md) sets C16's changed default `product-analytics.config.enabled` to `false` and its Privacy section turns it on after consent; upstream's own profiles keep `true` | built: C16 changed default, no switch ID | `delo/packages/bundle-local/tests/privacy-defaults.spec.ts` and `privacy-section.client.spec.tsx` |
| Session-log upload, upstream's default | `dsh-v0.2.2-rc.1` and this tree's upstream profiles: on by default. `session-log-deepseek` defaults `enabled` to `true` in `packages/session/session-log-deepseek/src/index.ts` at line 60, and the base bundle mounts the plugin in `packages/bundle/base/cordis.patch.yml` at line 43 | stock | Manual check: the two lines match this description, and neither file has a ledger entry. |
| Session-log upload, Delo's default | `dsh-v0.2.2-rc.1`: on. This tree: off in Delo's CLI profiles, where [`@delo/bundle-local`](../../packages/bundle-local/README.md) sets C16's changed default `session-log-deepseek.config.enabled` to `false` and its Privacy section turns it on after consent; upstream's own profiles, and so the recorded-session replay, keep the plugin's default `true` | built: C16 changed default, no switch ID | `delo/packages/bundle-local/tests/privacy-defaults.spec.ts`, `privacy-section.client.spec.tsx` and `apps/web/tests/delo-privacy-consent.e2e.ts` |
| Feedback-gated OTel session upload | `dsh-v0.2.2-rc.1` and this tree's upstream profiles: the base bundle includes a feedback-gated OTel session upload for every person and provider ([CLI reference](../../../apps/cli/reference/README.md)). This tree's Delo CLI profiles compose `session-telemetry-otel`, `command-feedback`, `ui-message-feedback` disabled or hidden, so no feedback leaves the machine; [`@delo/bundle-local`](../../packages/bundle-local/README.md) sets them as C16 changed defaults | built: C16 changed default, no switch ID | `delo/packages/bundle-local/tests/composition.spec.ts` (no enabled feedback exporter or feedback surface) |

### web_fetch

| Item | Baseline and this tree | Status | Evidence |
| --- | --- | --- | --- |
| Loopback and non-public targets | `dsh-v0.2.2-rc.1` and this tree: `web_fetch` fetches loopback and other non-public destinations, with no guard | stock | `packages/web/web-fetch-http/tests/fetch-http.spec.ts` |
| Fetch guard | `dsh-v0.2.2-rc.1`: no guard. This tree has no refusal of loopback, link-local or private targets by `web_fetch` | planned: `fetch_guard` (A100) | `parity-switches` |

### Consents

| Item | Baseline and this tree | Status | Evidence |
| --- | --- | --- | --- |
| Scheduled-task consent | `dsh-v0.2.2-rc.1`: one approved call creates turns that recur unattended; this tree has no consent that names the recurrence and the target session | planned: `scheduled_task_consent` (WP2.19) | `parity-switches` |
| Instruction-layer consent | `dsh-v0.2.2-rc.1`: a model-authored write to a skill, a preset or an `AGENTS.md` is approved, if at all, as a file write; this tree has no approval that names the effect and shows the diff | planned: `instruction_layer_consent` (A101) | `parity-switches` |
| MCP add-time consent | `dsh-v0.2.2-rc.1`: each MCP server command runs as trusted code outside the agent sandbox; this tree has no consent that names an added server's command | planned: `mcp_add_consent` (A101) | `parity-switches` |

### Confinement and containers

| Item | Baseline and this tree | Status | Evidence |
| --- | --- | --- | --- |
| Confinement rules | `dsh-v0.2.2-rc.1`: the sandbox confines file writes, and reads, Unix sockets and the network stay open; this tree has none of C1's five rules (`home-write`, `home-read`, `token-read`, `home-connect` and `docker-connect`) in its sandbox code | planned: contract [C1](../contracts/c01-home-layout.md); no switch ID or work package | Manual check: a search of `packages/` and `apps/` for the five rule names finds none; under `delo/` they appear only in contract pages, the home-layout contract package, the threat model and this page. |
| Container denial marker | `dsh-v0.2.2-rc.1`: a denial inside a container carries no environment marker; this tree's `containerDenialMarker` in `packages/sandbox/sandbox-policy/src/index.ts` at line 152 is off by default | built: `container_denial_marker` (switch-on scenario pending recording) | `packages/sandbox/sandbox-policy/tests/policy.spec.ts` |

### Studio and other C16 switches

| Item | Baseline and this tree | Status | Evidence |
| --- | --- | --- | --- |
| Preview notice | `dsh-v0.2.2-rc.1`: upstream's Web preview notice names DeepSeek Harness. This tree's Delo CLI profiles turn it off (`welcomeNotice`) and show Delo's own notice from [`@delo/bundle-local`](../../packages/bundle-local/README.md), which states that Delo is a pre-release community fork | built: C16 changed default `ui-settings-models.config.welcomeNotice` and composition row `delo-privacy`, no switch ID | `delo/packages/bundle-local/tests/notice.client.spec.tsx` and `composition.spec.ts` |
| Sidebar brand | `dsh-v0.2.2-rc.1`: the sidebar's default brand is upstream's mark and name (`DSH Local Build` with the build version). This tree's Delo CLI profiles show the product name as text and no mark, through the `delo-privacy` row of [`@delo/bundle-local`](../../packages/bundle-local/README.md), which the parity composition leaves disabled; the document title is a build setting (`DSH_CLIENT_TITLE`), which Delo's build sets and the parity build does not | built: C16 composition row `delo-privacy`, no switch ID | `delo/packages/bundle-local/tests/privacy-section.client.spec.tsx` (occupant registration) and `parity-switches` (the row stays disabled) |
| Studio additions | `dsh-v0.2.2-rc.1`: the stock look, with no Delo studio package; this tree mounts the theme, sidebar, chat states, settings layout and onboarding through `@delo/bundle-studio` in every Delo CLI profile, with the switch on, and the replay mounts none of them | built: `studio_additions`, a feature switch on `@delo/plugin-theme` | `parity-switches` |
| Main chat | `dsh-v0.2.2-rc.1`: no main chat; this tree has `@delo/plugin-main-chat`, an experimental plugin that no bundle mounts | built: `main_chat` (switch-on scenario pending recording) | `parity-switches` |
| Onboarding preset | `dsh-v0.2.2-rc.1` and this tree: `standard` is the default preset (`packages/bundle/web-app/cordis.patch.yml` at line 593). Planned: `ptc`, as C16's changed default `agent-preset-registry.config.default` | planned: C16 changed default; no switch ID or work package | Manual check: line 593 sets `standard`, and C16's changed-defaults table names the planned value. |
| `plugin_manager` read exemption | `dsh-v0.2.2-rc.1`: every `plugin_manager` action needs the `danger-full-access` escalation; this tree's `readActionsExempt` switch is off by default | built: `plugin_manager_read_exemption` (switch-on scenario pending recording) | `packages/boot/plugin-manager/tests/tools.spec.ts` |
| `profile_history` | `dsh-v0.2.2-rc.1`: no `history`, `read_config`, `configure`, `undo` or `restore` action; this tree's `profileHistory` switch is off by default | built: `profile_history` (switch-on scenario pending recording) | `packages/boot/plugin-manager/tests/tools.spec.ts` |
| Doctor | `dsh-v0.2.2-rc.1`: no doctor app; this tree's `doctor` switch is off by default, so the app runs no check, and no model sees it. `delorun doctor` is a separate Delo command that runs its own checks and reaches no model | built: `doctor` (feature switch; no switch-on scenario) | `packages/boot/doctor/tests/app.spec.ts` |
