/**
 * The rows `@delo/bundle-local` writes, why each differs from upstream's web profile, and the form each takes in
 * contract C16's parity composition. The module has no runtime import, so Delo's parity tooling reads it from source
 * without a build.
 *
 * @module @delo/bundle-local/rows
 */

/**
 * How one of this bundle's rows appears in C16's parity composition, which the parity overlay
 * (`delo/apps/tools/src/parity/composition/parity.overlay.yml`) restates.
 */
export type LocalRowParity =
  /** The row as this bundle writes it. */
  | { readonly kind: 'as-written'; readonly reason: string }
  /** The row as upstream's layers compose it: the parity overlay leaves this bundle's patch of it out. */
  | { readonly kind: 'upstream'; readonly reason: string }
  /** The inserted row, present and disabled: the parity composition mounts nothing of it. */
  | { readonly kind: 'disabled'; readonly reason: string }

/** One row of the composition that `@delo/bundle-local` changes or adds, with the reason the change exists. */
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

/** Every row in which a Delo CLI profile's composition differs from upstream's web profile. */
export const LOCAL_ROWS: readonly LocalRow[] = [
  {
    id: 'plugin-manager',
    kind: 'changed',
    reason: 'Plugin management protects Delo\'s consent and guard rows, the plugin changes held for review, the update gate, the update check, the plugin install check and the sandbox rows (`protectedPlugins`), so the `plugin_manager` tool, which full access runs without a prompt, can neither disable them, change their settings, nor deselect or remove this bundle; upstream protects only its management components. It asks the npmmirror registry only when the install check\'s `npmMirror` setting is on (`fallbackRegistries` reads `DELO_NPM_MIRROR`, which `delorun` sets at each start), where upstream asks it by default.',
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
    reason: 'DeepSeek\'s account and Platform sign-in is removed from Delo\'s CLI profiles, because the first release has no DeepSeek account service; upstream mounts it.',
    parity: {
      kind: 'upstream',
      reason: 'C16\'s changed default takes upstream\'s value: the replay signs no account in, and the overlay does not restate the row.',
    },
  },
  {
    id: 'session-telemetry-otel',
    kind: 'changed',
    reason: 'Feedback is not sent to DeepSeek\'s collector: the feedback exporter is disabled, because Delo\'s feedback has no DeepSeek destination.',
    parity: { kind: 'upstream', reason: 'C16\'s changed default takes upstream\'s value; the overlay does not restate the row.' },
  },
  {
    id: 'sandbox',
    kind: 'changed',
    reason: 'The sandbox row carries C1\'s home protection: `protectedHome` is the Delo home, with C1\'s read exemptions, so a confined command cannot read the consent stores under its `secrets/` directory, and the read and search tools of every row, the agent presets\' included, refuse the same paths; upstream mounts the row with no protected home.',
    parity: { kind: 'upstream', reason: 'The replay runs upstream\'s confinement: the overlay leaves the row out, so the provider protects no home, the read and search tools refuse nothing, and a recorded scenario that reads or searches the harness home replays as it was recorded.' },
  },
  {
    id: 'command-feedback',
    kind: 'changed',
    reason: 'The /feedback command is hidden, because it sends through the disabled feedback exporter and Delo has no feedback destination yet.',
    parity: { kind: 'upstream', reason: 'C16\'s changed default takes upstream\'s value; the overlay does not restate the row.' },
  },
  {
    id: 'product-analytics',
    kind: 'changed',
    reason: 'The desktop app\'s analytics is off until the person turns it on, as contract C11 requires; upstream turns it on.',
    parity: { kind: 'as-written', reason: 'C16 keeps Delo\'s value: the replay mounts no desktop Host.' },
  },
  {
    id: 'ui-settings-account',
    kind: 'changed',
    reason: 'The DeepSeek account menu, sign-in dialog and account section are hidden, because the first release has no DeepSeek account service.',
    parity: { kind: 'upstream', reason: 'C16\'s changed default takes upstream\'s value; the overlay does not restate the row.' },
  },
  {
    id: 'account-controller',
    kind: 'changed',
    reason: 'The API controller over the DeepSeek account service is removed with it: the controller requires `deepseekAccount`, which no enabled row provides, so mounted it would never activate; upstream mounts it.',
    parity: {
      kind: 'upstream',
      reason: 'C16\'s changed default takes upstream\'s value: the replay signs no account in, and the overlay does not restate the row.',
    },
  },
  {
    id: 'workspace-controller',
    kind: 'changed',
    reason: 'The studio\'s first-use workspace folder is the one `delorun start` resolves, `<documents>/Delo/default-workspace` or `<home>/Delo/default-workspace` where the platform reports no documents folder, so the studio has a default workspace on every platform; upstream\'s row sets none, and its own lookup gives up where the platform reports no documents folder.',
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
    reason: 'Upstream\'s preview notice is replaced by Delo\'s own notice (welcomeNotice off), and the other onboarding settings keep upstream\'s values.',
    parity: { kind: 'upstream', reason: 'C16\'s changed default takes upstream\'s value; the overlay does not restate the row.' },
  },
  {
    id: 'ui-message-feedback',
    kind: 'changed',
    reason: 'The message feedback surface (Like, Dislike and the dialog) is hidden, for the same reason as command-feedback.',
    parity: { kind: 'upstream', reason: 'C16\'s changed default takes upstream\'s value; the overlay does not restate the row.' },
  },
  {
    id: 'delo-privacy',
    kind: 'added',
    reason: 'The browser half of this bundle: the Privacy and About sections and the release check\'s switch in Settings, the Delo sidebar brand, and Delo\'s own preview notice.',
    parity: { kind: 'disabled', reason: 'Recorded web scenarios compare upstream\'s interface output, which has no Privacy section, shows upstream\'s brand and shows upstream\'s preview notice.' },
  },
  {
    id: 'delo-instruction-consent',
    kind: 'added',
    reason: 'The C16 switches `instruction_layer_consent` and `approved_plugin_write_consent` on: a model-authored write to a skill, a preset or an `AGENTS.md` asks, with the effect and the diff, before it commits, and the agent\'s first write in a chat to the folder of a plugin the person approved under Changes asks, naming the plugin, with the diff; the plugin\'s own defaults, off, are the parity values.',
    parity: { kind: 'disabled', reason: 'Both switches\' parity values are off, and a disabled row mounts nothing: upstream\'s write path runs unasked, as the recorded scenarios ran it.' },
  },
  {
    id: 'delo-mcp-consent',
    kind: 'added',
    reason: 'The C16 switch `mcp_add_consent` on: a stdio MCP server command starts only once the acceptance store holds an acceptance for it; the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: the mcpAddConsent service is absent, so every configured server starts as upstream starts it.' },
  },
  {
    id: 'delo-permission-defaults',
    kind: 'added',
    reason: 'The C16 switch `permission_defaults` on: a new workspace starts on the safer preset, and full access needs one consent per workspace, whose `sandboxModeGuard` is the one provider of that seam (A135); the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: the deployment default reaches every new chat and every mode switch is recorded, as upstream records it.' },
  },
  {
    id: 'delo-schedule-consent',
    kind: 'added',
    reason: 'The C16 switch `scheduled_task_consent` on: an approved schedule_create or schedule_edit names the recurrence and its target, and a due delivery is refused when the target chat left the preset the approval named; the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: the scheduleConsent service is absent, so approvals and deliveries keep upstream\'s text and behaviour.' },
  },
  {
    id: 'delo-fetch-guard',
    kind: 'added',
    reason: 'The C16 switch `fetch_guard` on: `web_fetch` refuses loopback, link-local, private-network and unique-local destinations with a typed reason; the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: the fetchGuard service is absent, so the recorded fetch scenarios call their loopback fixtures as they did.' },
  },
  {
    id: 'delo-delegation-consent',
    kind: 'added',
    reason: 'The C16 switch `external_agent_consent` on: an external agent such as Claude Code or Codex starts only after the person approves it at the home\'s computer or allowed it for the workspace, a read-only chat never starts one, each run stops after its time limit, and the model cannot install or enable one through `plugin_manager`; the person turns it off in Settings, External agents, which setup\'s prompts answer does not change, and the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: the delegationConsent service is absent, so external providers start and describe themselves as upstream\'s do.' },
    id: 'delo-plugin-changes',
    kind: 'added',
    reason: 'The C16 switch `plugin_changes_pending` on: an agent\'s `plugin_manager` install or removal does not run, it is recorded in the profile\'s change log as a pending change for the person\'s review, and the model reads that nothing was installed; the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: no listener or guard holds plugin_manager back, so it installs and removes as upstream does, behind its own approval.' },
  },
  {
    id: 'delo-update-gate',
    kind: 'added',
    reason: 'The C16 switch `update_turn_refusal` on: while `delorun update` or a stop waits for running chats, the first step of every new turn is refused with `UPDATE_PENDING`, so the wait ends once the running turns end; and the first step of every turn waits until `delorun` has checked the booted Host\'s rows and services (`holdUntilChecked`). The plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: the deloTurnGate service is absent, so every turn starts as upstream starts it.' },
  },
  {
    id: 'delo-update-check',
    kind: 'added',
    reason: 'The C16 switch `update_check` on: at start and once a day while the Host runs, the channel\'s newest release is fetched and verified as an update verifies it, and the studio shows a notice when it is newer; upstream makes no such request, and the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'Stock DSH makes no request for a newer release, and a disabled row mounts nothing: no service, no route and no check.' },
  },
  {
    id: 'delo-plugin-install-check',
    kind: 'added',
    reason: 'The plugin install check provides upstream\'s `pluginAudit` hook: every package an installation brings is checked for integrity, known advisories, very new versions and lookalike names, a known critical advisory needs the person\'s acceptance, and each installed plugin\'s files are recorded and compared at every start; upstream audits nothing.',
    parity: { kind: 'disabled', reason: 'Stock audits no plugin and makes no advisory or registry request for one, and a disabled row mounts nothing: no `pluginAudit` and no `deloPluginTrust`.' },
  },
  {
    id: 'delo-trash',
    kind: 'added',
    reason: 'Contract C8\'s trash: deleting a chat or a workspace in the studio moves it to the trash, the Trash section in Settings restores it or deletes it forever, and each start deletes what is older than 30 days; upstream has no chat delete and its workspace Delete keeps every chat.',
    parity: { kind: 'disabled', reason: 'Recorded scenarios compare upstream\'s interface output, which has no trash action and no Trash section, and a disabled row mounts nothing.' },
  },
  {
    id: 'delo-home-auth',
    kind: 'added',
    reason: 'The home\'s sign-in for remote access: it provides upstream\'s authenticator, keeping upstream\'s admission on the loopback listener, and serves the device routes and the reach sign-in (C4, C5).',
    parity: { kind: 'disabled', reason: 'The parity composition keeps upstream\'s own authenticator, and the reach service that needs this row is disabled there too.' },
  },
  {
    id: 'delo-reach',
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
  if (row === undefined) throw new Error(`@delo/bundle-local writes row ${JSON.stringify(id)}, which LOCAL_ROWS does not list`)
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
    if (!Array.isArray(insert)) throw new Error('@delo/bundle-local\'s patch holds a row that is neither an id patch nor an insert')
    return [{
      ...patch,
      insert: insert.map((entry: unknown) => {
        if (!isRecord(entry)) throw new Error('@delo/bundle-local inserts a row that is not a mapping')
        return localRow(entry['id']).parity.kind === 'disabled' ? { ...entry, disabled: true } : entry
      }),
    }]
  })
}
