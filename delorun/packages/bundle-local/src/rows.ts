/**
 * The rows `@delorun/bundle-local` writes, why each differs from upstream's web profile, and the form each takes in
 * contract C16's parity composition. The module has no runtime import, so Delorun's parity tooling reads it from source
 * without a build.
 *
 * @module @delorun/bundle-local/rows
 */

/**
 * How one of this bundle's rows appears in C16's parity composition, which the parity overlay
 * (`delorun/apps/tools/src/parity/composition/parity.overlay.yml`) restates.
 */
export type LocalRowParity =
  /** The row as this bundle writes it. */
  | { readonly kind: 'as-written'; readonly reason: string }
  /** The row as upstream's layers compose it: the parity overlay leaves this bundle's patch of it out. */
  | { readonly kind: 'upstream'; readonly reason: string }
  /** The inserted row, present and disabled: the parity composition mounts nothing of it. */
  | { readonly kind: 'disabled'; readonly reason: string }

/** One row of the composition that `@delorun/bundle-local` changes or adds, with the reason the change exists. */
export interface LocalRow {
  /** The row's entry id. */
  readonly id: string
  /** `changed` for an upstream row whose fields the bundle sets, `added` for a row the bundle inserts. */
  readonly kind: 'changed' | 'added'
  /** Why the row differs from upstream's web profile, in one sentence. */
  readonly reason: string
  /** The row's form in the parity composition. */
  readonly parity: LocalRowParity
}

/** Every row in which a Delorun CLI profile's composition differs from upstream's web profile. */
export const LOCAL_ROWS: readonly LocalRow[] = [
  {
    id: 'plugin-manager',
    kind: 'changed',
    reason: 'Plugin management protects Delorun\'s consent and guard rows, the start gate of live external agents, the plugin changes held for review, the update gate, the update check, the trust bill, the plugin install check and the sandbox rows (`protectedPlugins`), so the `plugin_manager` tool, which full access runs without a prompt, can neither disable them, change their settings, nor deselect or remove this bundle; upstream protects only its management components. It asks the npmmirror registry only when the install check\'s `npmMirror` setting is on (`fallbackRegistries` reads `DELORUN_NPM_MIRROR`, which `delorun` sets at each start), where upstream asks it by default.',
    parity: { kind: 'upstream', reason: 'The replay runs upstream\'s protection: the overlay leaves the row out, so `plugin_manager` lists and refuses the recorded scenarios\' rows as upstream does.' },
  },
  {
    id: 'session-log-deepseek',
    kind: 'changed',
    reason: 'DeepSeek\'s session-log upload is off until the person turns it on, as contract C11 requires; upstream turns it on.',
    parity: {
      kind: 'upstream',
      reason: 'C16\'s changed default takes upstream\'s value. The overlay follows each replay\'s root configuration, which turns '
        + 'upload off for the headless and ACP corpora and leaves it on elsewhere, so restating the row would override it.',
    },
  },
  {
    id: 'deepseek-account',
    kind: 'changed',
    reason: 'DeepSeek\'s account and Platform sign-in is removed from Delorun\'s CLI profiles, because the first release has no DeepSeek account service; upstream mounts it.',
    parity: {
      kind: 'upstream',
      reason: 'C16\'s changed default takes upstream\'s value: the replay signs no account in, and the overlay does not restate the row.',
    },
  },
  {
    id: 'session-telemetry-otel',
    kind: 'changed',
    reason: 'Feedback is not sent to DeepSeek\'s collector: the feedback exporter is disabled, because Delorun\'s feedback has no DeepSeek destination.',
    parity: { kind: 'upstream', reason: 'C16\'s changed default takes upstream\'s value; the overlay does not restate the row.' },
  },
  {
    id: 'sandbox',
    kind: 'changed',
    reason: 'The sandbox row carries C1\'s home protection: `protectedHome` is the Delorun home, with C1\'s read exemptions, so a confined command cannot read the consent stores under its `secrets/` directory, and the read and search tools of every row, the agent presets\' included, refuse the same paths; upstream mounts the row with no protected home.',
    parity: { kind: 'upstream', reason: 'The replay runs upstream\'s confinement: the overlay leaves the row out, so the provider protects no home, the read and search tools refuse nothing, and a recorded scenario that reads or searches the harness home replays as it was recorded.' },
  },
  {
    id: 'command-feedback',
    kind: 'changed',
    reason: 'The /feedback command is hidden, because it sends through the disabled feedback exporter and Delorun has no feedback destination yet.',
    parity: { kind: 'upstream', reason: 'C16\'s changed default takes upstream\'s value; the overlay does not restate the row.' },
  },
  {
    id: 'product-analytics',
    kind: 'changed',
    reason: 'The desktop app\'s analytics is off until the person turns it on, as contract C11 requires; upstream turns it on.',
    parity: { kind: 'as-written', reason: 'C16 keeps Delorun\'s value: the replay mounts no desktop Host.' },
  },
  {
    id: 'ui-settings-account',
    kind: 'changed',
    reason: 'The DeepSeek account menu, sign-in dialog and account section are hidden, because the first release has no DeepSeek account service.',
    parity: { kind: 'upstream', reason: 'C16\'s changed default takes upstream\'s value; the overlay does not restate the row.' },
  },
  {
    id: 'ui-account-notifications',
    kind: 'changed',
    reason: 'The account notifications are hidden, because they poll DeepSeek\'s servers for cards shown beside the account menu and the first release has no DeepSeek account service.',
    parity: { kind: 'upstream', reason: 'C16\'s changed default takes upstream\'s value; the overlay does not restate the row.' },
  },
  {
    id: 'workspace-controller',
    kind: 'changed',
    reason: 'The studio\'s first-use workspace folder is the one `delorun start` resolves, `<documents>/Delorun/default-workspace` or `<home>/Delorun/default-workspace` where the platform reports no documents folder, so the studio has a default workspace on every platform; upstream\'s row sets none, and its own lookup gives up where the platform reports no documents folder.',
    parity: { kind: 'upstream', reason: 'The C16 switch `default_workspace_directory` is a presence switch whose parity value is off: the overlay leaves the row out, so the replay places the first-use workspace by upstream\'s own lookup.' },
  },
  {
    id: 'connection',
    kind: 'changed',
    reason: 'The C16 switch `one_time_launch_tokens` on: a studio sign-in link works once, within 60 seconds, and a refused request tells the person to run `delorun open`; upstream keeps one reusable launch token for the life of the Host.',
    parity: { kind: 'upstream', reason: 'The switch\'s parity value is off: the overlay leaves the row to upstream\'s web bundle, so the recorded web scenarios sign in with the reusable process token, as they were recorded.' },
  },
  {
    id: 'ui-settings-models',
    kind: 'changed',
    reason: 'Upstream\'s preview notice is replaced by Delorun\'s own notice (welcomeNotice off), and the other onboarding settings keep upstream\'s values.',
    parity: { kind: 'upstream', reason: 'C16\'s changed default takes upstream\'s value; the overlay does not restate the row.' },
  },
  {
    id: 'ui-message-feedback',
    kind: 'changed',
    reason: 'The message feedback surface (Like, Dislike and the dialog) is hidden, for the same reason as command-feedback.',
    parity: { kind: 'upstream', reason: 'C16\'s changed default takes upstream\'s value; the overlay does not restate the row.' },
  },
  {
    id: 'delorun-privacy',
    kind: 'added',
    reason: 'The browser half of this bundle: the Privacy and About sections and the release check\'s switch in Settings, the Delorun sidebar brand, and Delorun\'s own preview notice.',
    parity: { kind: 'disabled', reason: 'Recorded web scenarios compare upstream\'s interface output, which has no Privacy section, shows upstream\'s brand and shows upstream\'s preview notice.' },
  },
  {
    id: 'delorun-instruction-consent',
    kind: 'added',
    reason: 'The C16 switches `instruction_layer_consent` and `approved_plugin_write_consent` on: a model-authored write to a skill, a preset or an `AGENTS.md` asks, with the effect and the diff, before it commits, and the agent\'s first write in a chat to the folder of a plugin the person approved under Changes asks, naming the plugin, with the diff; the plugin\'s own defaults, off, are the parity values.',
    parity: { kind: 'disabled', reason: 'Both switches\' parity values are off, and a disabled row mounts nothing: upstream\'s write path runs unasked, as the recorded scenarios ran it.' },
  },
  {
    id: 'delorun-mcp-consent',
    kind: 'added',
    reason: 'The C16 switch `mcp_add_consent` on: a stdio MCP server command starts only once the acceptance store holds an acceptance for it; the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: the mcpAddConsent service is absent, so every configured server starts as upstream starts it.' },
  },
  {
    id: 'delorun-permission-defaults',
    kind: 'added',
    reason: 'The C16 switch `permission_defaults` on: a new workspace starts on the safer preset, and full access needs one consent per workspace, whose `sandboxModeGuard` is the one provider of that seam; the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: the deployment default reaches every new chat and every mode switch is recorded, as upstream records it.' },
  },
  {
    id: 'delorun-schedule-consent',
    kind: 'added',
    reason: 'The C16 switch `scheduled_task_consent` on: an approved schedule_create or schedule_edit names the recurrence and its target, and a due delivery is refused when the target chat left the preset the approval named; the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: the scheduleConsent service is absent, so approvals and deliveries keep upstream\'s text and behaviour.' },
  },
  {
    id: 'delorun-fetch-guard',
    kind: 'added',
    reason: 'The C16 switch `fetch_guard` on: `web_fetch` refuses loopback, link-local, private-network and unique-local destinations with a typed reason; the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: the fetchGuard service is absent, so the recorded fetch scenarios call their loopback fixtures as they did.' },
  },
  {
    id: 'delorun-tool-failure-guard',
    kind: 'added',
    reason: 'The C16 switch `tool_failure_guard` on: after 3 failed tool calls in a row the model reads one reminder, and a turn with 6 failed calls in a row, or 8 of its last 12, stops before its next model request with one notice in the chat; the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: recorded scenarios whose tool calls fail keep running as they were recorded.' },
  },
  {
    id: 'delorun-plugin-authoring',
    kind: 'added',
    reason: 'The delorun-plugin-authoring skill: it teaches the agent to scaffold a plugin in the chat\'s workspace with `delorun plugin new`, and that turning the plugin on is the person\'s step at the computer; upstream has no such skill.',
    parity: { kind: 'disabled', reason: 'Recorded scenarios list upstream\'s skills, and a disabled row mounts nothing.' },
  },
  {
    id: 'delorun-report-problem',
    kind: 'added',
    reason: 'The delorun-report-problem skill, behind "Help me report this": it teaches the agent to ask what went wrong, read the version and recent logs through the CLI and draft a GitHub issue in the bug form\'s sections, and that the person reviews and sends it; upstream has no such skill.',
    parity: { kind: 'disabled', reason: 'Stock has no such skill, and a disabled row mounts nothing: no skill is listed.' },
  },
  {
    id: 'delorun-delegation-consent',
    kind: 'added',
    reason: 'The C16 switch `external_agent_consent` on: an external agent such as Claude Code or Codex starts only after the person approves it at the home\'s computer or allowed it for the workspace, a read-only chat never starts one, each run stops after its time limit, and the model cannot install or enable one through `plugin_manager`; the person turns it off in Settings, External agents, which setup\'s prompts answer does not change, and the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: the delegationConsent service is absent, so external providers start and describe themselves as upstream\'s do.' },
  },
  {
    id: 'delorun-external-agents',
    kind: 'added',
    reason: 'The start gate of live external agents, the only path that starts Claude Code or Codex for a seat or a limits check, with the C16 switch `external_agent_limit_refusal` on: a reached plan limit with a reset time in the future refuses a start with a fixed sentence to the model; upstream has no gate, and the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: no externalAgents service exists, so no live agent starts and no limit refuses a one-shot run.' },
  },
  {
    id: 'delorun-agent-claude-code',
    kind: 'added',
    reason: 'The Claude Code driver of the live external-agent start gate: it registers with the gate only while upstream\'s `claude-code` provider is registered, which needs the Claude Code pack the person adds; upstream has no live agents, and a disabled row is the parity value.',
    parity: { kind: 'disabled', reason: 'A disabled row mounts nothing: no driver registers with the gate, so no live Claude Code program can start.' },
  },
  {
    id: 'delorun-agent-codex',
    kind: 'added',
    reason: 'The Codex driver of the live external-agent start gate: it registers with the gate only while upstream\'s `codex` provider is registered, which needs the Codex pack the person adds; upstream has no live agents, and a disabled row is the parity value.',
    parity: { kind: 'disabled', reason: 'A disabled row mounts nothing: no driver registers with the gate, so no live Codex program can start.' },
  },
  {
    id: 'delorun-agent-seats',
    kind: 'added',
    reason: 'The C16 switch `live_agents` on, with live external agents behind the `externalAgents.liveAgents` preview flag, off unless a profile row sets it: with it on, the lead\'s model gets a hand-off tool per agent, and the agent\'s chat, approvals and lists appear; with it off the row adds no tool and no UI. Upstream has no live agents.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: no hand-off tool, seat provider or seat UI exists, and the one-shot subagent tools run as upstream\'s do.' },
  },
  {
    id: 'delorun-multiview',
    kind: 'added',
    reason: 'Multiview: agents pinned from the agents list, or pinned and opened when a hand-off starts, show beside the main chat in a layout the person arranges; it does nothing until an agent is pinned or handed work, and its settings choose auto-open, the pane limit, the pane composer and reopening on return. Upstream has no such view.',
    parity: { kind: 'disabled', reason: 'A disabled row mounts nothing: no pin button, header button or panel exists, and the agents list and header are upstream\'s.' },
  },
  {
    id: 'delorun-plugin-changes',
    kind: 'added',
    reason: 'The C16 switch `plugin_changes_pending` on: an agent\'s `plugin_manager` install or removal does not run, it is recorded in the profile\'s change log as a pending change for the person\'s review, and the model reads that nothing was installed; the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: no listener or guard holds plugin_manager back, so it installs and removes as upstream does, behind its own approval.' },
  },
  {
    id: 'delorun-plugin-update',
    kind: 'added',
    reason: 'The studio\'s update: Check now, Update now with the update report, Go back after an update, and Stop Delorun, as Host routes that hand each step to the home process, which verifies, installs, switches and rolls back; upstream has no such routes.',
    parity: { kind: 'disabled', reason: 'Nothing in upstream calls the plugin; without the row no update route exists, and Delorun updates only with `delorun update`.' },
  },
  {
    id: 'delorun-packs',
    kind: 'added',
    reason: 'Plugin packs: plugins outside the default install download from the release channel, verify against the release\'s signed packs file and load through the plugin manager, from one Host install queue that survives a reload; the `packs` remote lists and changes that queue.',
    parity: { kind: 'disabled', reason: 'Nothing in upstream calls the plugin; without the row no `packs` remote exists and every plugin install runs through the plugin manager as upstream does.' },
  },
  {
    id: 'delorun-workspace-rename',
    kind: 'added',
    reason: 'The C16 switch `rename_workspace_tool` on: the agent has a `rename_workspace` tool that renames a workspace through the workspace registry, the way the studio\'s rename does, after the person allows it; the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: the model has no tool for renaming a workspace.' },
  },
  {
    id: 'delorun-prompt-wording',
    kind: 'added',
    reason: 'The C16 switch `model_prompt` on: the system prompt\'s checkout and studio paragraphs say Delorun, and the workflow and terminal paragraphs and the checkout text follow Delorun\'s rules (a tool\'s paragraph only while the step offers the tool; the checkout text only in a real checkout); the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: the prompt sections keep upstream\'s text.' },
  },
  {
    id: 'delorun-update-gate',
    kind: 'added',
    reason: 'The C16 switch `update_turn_refusal` on: while `delorun update` or a stop waits for running chats, the first step of every new turn is refused with `UPDATE_PENDING`, so the wait ends once the running turns end; and the first step of every turn waits until `delorun` has checked the booted Host\'s rows and services (`holdUntilChecked`). The plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: the delorunTurnGate service is absent, so every turn starts as upstream starts it.' },
  },
  {
    id: 'delorun-update-check',
    kind: 'added',
    reason: 'The C16 switch `update_check` on: at start and once a day while the Host runs, the channel\'s newest release is fetched and verified as an update verifies it, and the studio shows a notice when it is newer; upstream makes no such request, and the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'Stock DSH makes no request for a newer release, and a disabled row mounts nothing: no service, no route and no check.' },
  },
  {
    id: 'delorun-trust',
    kind: 'added',
    reason: 'The trust bill of contract C15: the studio\'s sidebar shows a badge of what this Delorun runs and how much of it was checked, with a panel that names the signed release, the release log, the plugins and the person\'s changes and runs the `verify` stage on request at the home\'s own computer; upstream has no such surface, and the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'Stock DSH has no trust bill route, and a disabled row mounts nothing: no service and no route.' },
  },
  {
    id: 'delorun-profile-versions',
    kind: 'added',
    reason: 'Setup versions in Settings: the profile history\'s versions are listed and compared for any signed-in studio, and saving the setup or switching to a version is answered only on the loopback listener, at the home\'s computer; upstream has no such page.',
    parity: { kind: 'disabled', reason: 'Stock offers no version page, and a disabled row mounts nothing: no route.' },
  },
  {
    id: 'delorun-requirements',
    kind: 'added',
    reason: 'Needs setup in Plugins: one read-only route tells the studio which rows of an optional bundle need a program, a setting or a platform they lack, from the bundle\'s own declaration; it changes nothing and upstream has no such state.',
    parity: { kind: 'disabled', reason: 'Stock Plugins has no needs-setup state, and a disabled row mounts nothing: no route.' },
  },
  {
    id: 'delorun-report',
    kind: 'added',
    reason: 'Report a problem: one read-only route gives the studio the versions, the system and a redacted excerpt of recent errors, and the address of the issue form, so the person can review a pre-filled GitHub issue and send it themselves; the row makes no request, and upstream has no such page.',
    parity: { kind: 'disabled', reason: 'Stock has no report route, and a disabled row mounts nothing: no route.' },
  },
  {
    id: 'delorun-run-settings',
    kind: 'added',
    reason: 'How Delorun runs in Settings: how much Delorun asks, running in the background, the studio\'s port and phone access are read for any signed-in studio and changed through the same writes `delorun setup` makes; turning questions off or the background on needs a device\'s Face ID or PIN, and dangerous mode, the port and phone access are answered only on the loopback listener, at the home\'s computer; upstream has no such page.',
    parity: { kind: 'disabled', reason: 'Stock offers no such page, and a disabled row mounts nothing: no route.' },
  },
  {
    id: 'delorun-plugin-install-check',
    kind: 'added',
    reason: 'The plugin install check provides upstream\'s `pluginAudit` hook: every package an installation brings is checked for integrity, known advisories, very new versions and lookalike names, a known critical advisory needs the person\'s acceptance, and each installed plugin\'s files are recorded and compared at every start; upstream audits nothing.',
    parity: { kind: 'disabled', reason: 'Stock audits no plugin and makes no advisory or registry request for one, and a disabled row mounts nothing: no `pluginAudit` and no `delorunPluginTrust`.' },
  },
  {
    id: 'delorun-trash',
    kind: 'added',
    reason: 'Contract C8\'s trash: deleting a chat or a workspace in the studio moves it to the trash, the Trash section in Settings restores it or deletes it forever, and each start deletes what is older than 30 days; upstream has no chat delete and its workspace Delete keeps every chat.',
    parity: { kind: 'disabled', reason: 'Recorded scenarios compare upstream\'s interface output, which has no trash action and no Trash section, and a disabled row mounts nothing.' },
  },
  {
    id: 'delorun-home-auth',
    kind: 'added',
    reason: 'The home\'s sign-in for remote access: it provides upstream\'s authenticator, keeping upstream\'s admission on the loopback listener, and serves the device routes and the reach sign-in (C4, C5).',
    parity: { kind: 'disabled', reason: 'The parity composition keeps upstream\'s own authenticator, and the reach service that needs this row is disabled there too.' },
  },
  {
    id: 'delorun-reach',
    kind: 'added',
    reason: 'The C16 switch `reach` on: the reach service mounts, with every option off until the person turns it on (C7).',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: no reach listener and no status route exist.' },
  },
]

/** One patch of a Cordis patch file, as parsed. */
export type PatchRow = Readonly<Record<string, unknown>>

/**
 * The listed row of an id.
 * @param id - an entry id.
 * @returns its {@link LOCAL_ROWS} entry.
 * @throws Error when the id is not listed.
 */
function localRow(id: unknown): LocalRow {
  const row = LOCAL_ROWS.find(entry => entry.id === id)
  if (row === undefined) throw new Error(`@delorun/bundle-local writes row ${JSON.stringify(id)}, which LOCAL_ROWS does not list`)
  return row
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The parity form of this bundle's patch list: each row as {@link LOCAL_ROWS} gives its parity form.
 * @param patches - the patches of this bundle's `cordis.patch.yml`, parsed with their `!!js` values kept.
 * @returns the patches the parity overlay restates, in the same order, without the patches of `upstream` rows.
 * @throws Error when a patch writes a row {@link LOCAL_ROWS} does not list, or is neither an id patch nor an insert.
 */
export function parityPatches(patches: readonly PatchRow[]): PatchRow[] {
  return patches.flatMap((patch) => {
    if (typeof patch['id'] === 'string') return localRow(patch['id']).parity.kind === 'upstream' ? [] : [patch]
    const insert = patch['insert']
    if (!Array.isArray(insert)) throw new Error('@delorun/bundle-local\'s patch holds a row that is neither an id patch nor an insert')
    return [{
      ...patch,
      insert: insert.map((entry: unknown) => {
        if (!isRecord(entry)) throw new Error('@delorun/bundle-local inserts a row that is not a mapping')
        return localRow(entry['id']).parity.kind === 'disabled' ? { ...entry, disabled: true } : entry
      }),
    }]
  })
}
