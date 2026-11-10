# Parity checklist

English | [中文](parity.zh.md)

The parity checklist records, for each stock DeepSeek Harness (DSH) area that Delo is compared against and for each deliberate difference, the status of that area in this tree and one piece of evidence. Every row names its baseline, the recorded upstream tag `dsh-v0.2.2-rc.1`, which the [parity composition](../contracts/c16-parity-composition.md) replays. The page covers the areas below, the switches and changed defaults that the parity composition contract lists, and the differences that the [comparison page](../guide/delo-vs-stock.md) names. It does not inventory every stock feature.

## How rows are judged

The status column states what this tree does. `built` means the change is in the tree: the row names its switch ID, or, for a Delo change that has no switch, says `no switch` and names its ledger entry. `planned` means the change is not in the tree: the row names the switch ID and work package from the registry or, where the registry has no entry, the C16 changed default or the contract that defines it. `stock` means upstream's behaviour at the baseline is unchanged in the area.

Each row gives one evidence. A check name, such as `parity-switches`, runs `node_modules/.bin/tsx delo/apps/tools/src/parity/composition/check-parity-switches.ts`, which reads the switch registry, the switch fields and the parity overlay. A spec path names a test file that asserts the row. An entry that begins with Manual check: names the source lines that a reviewer reads to confirm the row.

Nine built switches have a switch-on scenario that is pending recording. `parity-switches` reports each one as pending, not as passing, so this page claims no replay result for them.

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
| Home directory | `dsh-v0.2.2-rc.1`: the home is `~/.dsh`, named by `DSH_HOME_DIR_NAME` in `packages/util/home-paths/src/index.ts` at line 12. This tree: `delorun` resolves its home from `DELO_HOME` or `~/.delo` through [`@delo/home`](../../packages/home/README.md), refuses `~/.dsh` and paths inside it, and sets `DSH_HOME` to the Delo home for every runtime process it starts; upstream's own `dsh` command still uses `~/.dsh` | built: contract [C1](../contracts/c01-home-layout.md), no switch ID | `delo/packages/home/tests/home.integration.spec.ts` |
| DeepSeek account and Platform | `dsh-v0.2.2-rc.1`: `packages/credentials/deepseek-account`, `packages/credentials/deepseek-account-platform` and `packages/llm/llm-deepseek-account` are in the tree. This tree's Delo CLI profiles compose `deepseek-account` disabled, where [`@delo/bundle-local`](../../packages/bundle-local/README.md) sets it as a C16 changed default, so no Platform sign-in, Usage or Top-up page is served and `llm-deepseek-account` stays inert; the parity composition keeps upstream's row, which the overlay leaves out | built: C16 changed default, no switch ID | `delo/packages/bundle-local/tests/composition.integration.spec.ts` (no enabled `deepseek-account` row) |

### Permissions

| Item | Baseline and this tree | Status | Evidence |
| --- | --- | --- | --- |
| Full access consent per workspace | `dsh-v0.2.2-rc.1`: full access needs no consent, as C16's parity column states. This tree: [`@delo/plugin-permission-defaults`](../../packages/plugin-permission-defaults/README.md) refuses a switch to full access in a workspace without a recorded consent; no surface asks for that consent, so the switch is refused in every workspace, and a per-call escalation still goes through upstream's approval; mounted on in Delo's CLI profiles and in the profile `delorun headless` boots, where a full-access request is also refused before boot for a working directory without a recorded grant | built: `permission_defaults` (no asking surface) | `delo/packages/plugin-permission-defaults/tests/permission-defaults.spec.ts` and `parity-switches` |
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
| Session-log upload, Delo's default | `dsh-v0.2.2-rc.1`: on. This tree: off in Delo's CLI profiles, where [`@delo/bundle-local`](../../packages/bundle-local/README.md) sets C16's changed default `session-log-deepseek.config.enabled` to `false` and its Privacy section turns it on after consent; `@delo/bundle-headless` sets the same value in the profile `delorun headless` boots; upstream's own profiles, and so the recorded-session replay, keep the plugin's default `true` | built: C16 changed default, no switch ID | `delo/packages/bundle-local/tests/privacy-defaults.spec.ts`, `privacy-section.client.spec.tsx` and `apps/web/tests/delo-privacy-consent.e2e.ts` |
| Feedback-gated OTel session upload | `dsh-v0.2.2-rc.1` and this tree's upstream profiles: the base bundle includes a feedback-gated OTel session upload for every person and provider ([CLI reference](../../../apps/cli/reference/README.md)). This tree's Delo CLI profiles compose `session-telemetry-otel`, `command-feedback`, `ui-message-feedback` disabled or hidden, so no feedback leaves the machine; [`@delo/bundle-local`](../../packages/bundle-local/README.md) sets them as C16 changed defaults | built: C16 changed default, no switch ID | `delo/packages/bundle-local/tests/composition.integration.spec.ts` (no enabled feedback exporter or feedback surface) |

### web_fetch

| Item | Baseline and this tree | Status | Evidence |
| --- | --- | --- | --- |
| Loopback and non-public targets | `dsh-v0.2.2-rc.1` and this tree: `web_fetch` fetches loopback and other non-public destinations, with no guard | stock | `packages/web/web-fetch-http/tests/fetch-http.spec.ts` |
| Fetch guard | `dsh-v0.2.2-rc.1`: no guard. This tree: [`@delo/plugin-fetch-guard`](../../packages/plugin-fetch-guard/README.md) makes the HTTP fetch provider refuse loopback, link-local, private-network and cloud metadata targets before it connects; `@delo/bundle-local` mounts it on in Delo's CLI profiles and `@delo/bundle-headless` in the profile `delorun headless` boots; upstream's profiles do not mount it | built: `fetch_guard` | `delo/packages/plugin-fetch-guard/tests/guard.spec.ts`, `provider-guard.spec.ts` and `parity-switches` |

### Consents

| Item | Baseline and this tree | Status | Evidence |
| --- | --- | --- | --- |
| Scheduled-task consent | `dsh-v0.2.2-rc.1`: one approved call creates turns that recur unattended. This tree: [`@delo/plugin-schedule-consent`](../../packages/plugin-schedule-consent/README.md) makes creating or editing a task ask with the recurrence, the target and its preset, and refuses a due delivery when the target chat left the preset the approval named; mounted on in Delo's CLI profiles only | built: `scheduled_task_consent` | `packages/schedule/tool-schedule/tests/consent.spec.ts`, `packages/schedule/schedule/tests/consent.spec.ts` and `parity-switches` |
| Instruction-layer consent | `dsh-v0.2.2-rc.1`: a model-authored write to a skill, a preset or an `AGENTS.md` is approved, if at all, as a file write. This tree: [`@delo/plugin-instruction-consent`](../../packages/plugin-instruction-consent/README.md) makes such a write through the file tools ask, naming the effect and showing the diff; a shell command's write is not reviewed; mounted on in Delo's CLI profiles and in the profile `delorun headless` boots, where the write is refused because no one can answer | built: `instruction_layer_consent` | `delo/packages/plugin-instruction-consent/tests/consent.spec.ts`, `packages/fs/tool-fs/tests/tools.spec.ts` and `parity-switches` |
| Approved-plugin write consent | `dsh-v0.2.2-rc.1`: the agent writes to the folder of an installed plugin as to any other file; this tree's `approvedPluginWrites` switch of `@delo/plugin-instruction-consent` is on in Delo's CLI profiles, and asks before the agent's first write in a chat to the folder of a plugin the person approved under Changes, naming the plugin, with the diff | built: `approved_plugin_write_consent` (switch-on scenario pending recording) | `delo/packages/plugin-instruction-consent/tests/plugin-folders.spec.ts` |
| MCP add-time consent | `dsh-v0.2.2-rc.1`: each MCP server command runs as trusted code outside the agent sandbox. This tree: [`@delo/plugin-mcp-consent`](../../packages/plugin-mcp-consent/README.md) keeps a stdio server stopped, with a refusal naming its command and arguments, until the acceptance store holds that command; no screen or command records an acceptance, so such a server does not start; mounted on in Delo's CLI profiles only | built: `mcp_add_consent` (no asking surface) | `packages/mcp/mcp-client/tests/consent.spec.ts`, `delo/packages/plugin-mcp-consent/tests/consent.spec.ts` and `parity-switches` |

### Confinement and containers

| Item | Baseline and this tree | Status | Evidence |
| --- | --- | --- | --- |
| Confinement rules | `dsh-v0.2.2-rc.1`: the sandbox confines file writes, and reads, Unix sockets and the network stay open. This tree: upstream's local sandbox provider takes a protected home, its readable entries and denied sockets, and Delo's CLI profiles set them ([C1](../contracts/c01-home-layout.md)): bwrap and Seatbelt deny reads and writes under the home and connections to the denied sockets, Landlock denies reads and writes under the home and no socket connection, and the Windows runner confines writes only. Upstream's profiles set none of them; `delorun headless` sets them through the sandbox overlay | built: `sandbox_protected_reads` on `@deepseek-ai/dsh-sandbox-local` `protectedHome` | `packages/sandbox/sandbox-local/tests/protected-home.spec.ts`, `delo/packages/bundle-local/tests/confinement.integration.spec.ts` |
| Container denial marker | `dsh-v0.2.2-rc.1`: a denial inside a container carries no environment marker; this tree's `containerDenialMarker` in `packages/sandbox/sandbox-policy/src/index.ts` at line 152 is off by default | built: `container_denial_marker` (switch-on scenario pending recording) | `packages/sandbox/sandbox-policy/tests/policy.spec.ts` |

### Studio and other C16 switches

| Item | Baseline and this tree | Status | Evidence |
| --- | --- | --- | --- |
| Preview notice | `dsh-v0.2.2-rc.1`: upstream's Web preview notice names DeepSeek Harness. This tree's Delo CLI profiles turn it off (`welcomeNotice`) and show Delo's own notice from [`@delo/bundle-local`](../../packages/bundle-local/README.md), which states that Delo is a pre-release community fork | built: C16 changed default `ui-settings-models.config.welcomeNotice` and composition row `delo-privacy`, no switch ID | `delo/packages/bundle-local/tests/notice.client.spec.tsx` and `composition.integration.spec.ts` |
| Sidebar brand | `dsh-v0.2.2-rc.1`: the sidebar's default brand is upstream's mark and name (`DSH Local Build` with the build version). This tree's Delo CLI profiles show the product name as text and no mark, through the `delo-privacy` row of [`@delo/bundle-local`](../../packages/bundle-local/README.md), which the parity composition leaves disabled; the document title is a build setting (`DSH_CLIENT_TITLE`), which Delo's build sets and the parity build does not | built: C16 composition row `delo-privacy`, no switch ID | `delo/packages/bundle-local/tests/privacy-section.client.spec.tsx` (occupant registration) and `parity-switches` (the row stays disabled) |
| Studio additions | `dsh-v0.2.2-rc.1`: the stock look, with no Delo studio package; this tree mounts the theme, sidebar, chat states, settings layout and onboarding through `@delo/bundle-studio` in every Delo CLI profile, with the switch on, and the replay mounts none of them | built: `studio_additions`, a feature switch on `@delo/plugin-theme` | `parity-switches` |
| Default workspace folder | `dsh-v0.2.2-rc.1`: the first-use workspace goes to `<Documents>/deepseek-harness/default-workspace`, and to no folder where the platform reports no documents folder, as on Linux and WSL without an XDG Documents folder. This tree: `delorun start` resolves `<documents>/Delo/default-workspace`, or `<home>/Delo/default-workspace` where the platform reports none, and [`@delo/bundle-local`](../../packages/bundle-local/README.md)'s `workspace-controller` row sets it as `defaultWorkspaceDirectory`; the replay leaves the row to upstream | built: `default_workspace_directory`, a presence switch on `@deepseek-ai/dsh-api-workspace-controller` (switch-on scenario pending recording) | `delo/apps/cli/tests/default-workspace.spec.ts` and `parity-switches` |
| Main chat | `dsh-v0.2.2-rc.1`: no main chat; this tree has `@delo/plugin-main-chat`, an experimental plugin that no bundle mounts | built: `main_chat` (switch-on scenario pending recording) | `parity-switches` |
| Onboarding preset | `dsh-v0.2.2-rc.1` and this tree: `standard` is the default preset (`packages/bundle/web-app/cordis.patch.yml` at line 593). Planned: `ptc`, as C16's changed default `agent-preset-registry.config.default` | planned: C16 changed default; no switch ID or work package | Manual check: line 593 sets `standard`, and C16's changed-defaults table names the planned value. |
| `plugin_manager` read exemption | `dsh-v0.2.2-rc.1`: every `plugin_manager` action needs the `danger-full-access` escalation; this tree's `readActionsExempt` switch is off by default | built: `plugin_manager_read_exemption` (switch-on scenario pending recording) | `packages/boot/plugin-manager/tests/tools.spec.ts` |
| `profile_history` | `dsh-v0.2.2-rc.1`: no `history`, `read_config`, `configure`, `undo` or `restore` action; this tree's `profileHistory` switch is off by default | built: `profile_history` (switch-on scenario pending recording) | `packages/boot/plugin-manager/tests/tools.spec.ts` |
| Plugin changes held for review | `dsh-v0.2.2-rc.1`: an agent's `plugin_manager` `install_bundle` or `remove_bundle` runs once its full-access approval is given; this tree's `@delo/plugin-changes` switch is off by default, and on it records the call as a pending change in the profile's change log and denies it, so nothing is installed or removed until the person applies it with `delorun changes` | built: `plugin_changes_pending` (switch-on scenario pending recording) | `delo/packages/plugin-changes/tests/plugin-changes.spec.ts` |
| Doctor | `dsh-v0.2.2-rc.1`: no doctor app; this tree's `doctor` switch is off by default, so the app runs no check, and no model sees it. `delorun doctor` is a separate Delo command that runs its own checks and reaches no model | built: `doctor` (feature switch; no switch-on scenario) | `packages/boot/doctor/tests/app.spec.ts` |
