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
    reason: 'The browser half of this bundle: the Privacy section in Settings, the Delo sidebar brand, and Delo\'s own preview notice.',
    parity: { kind: 'disabled', reason: 'Recorded web scenarios compare upstream\'s interface output, which has no Privacy section, shows upstream\'s brand and shows upstream\'s preview notice.' },
  },
  {
    id: 'delo-instruction-consent',
    kind: 'added',
    reason: 'The C16 switch `instruction_layer_consent` on: a model-authored write to a skill, a preset or an `AGENTS.md` asks, with the effect and the diff, before it commits; the plugin\'s own default, off, is the parity value.',
    parity: { kind: 'disabled', reason: 'The switch\'s parity value is off, and a disabled row mounts nothing: upstream\'s write path runs unasked, as the recorded scenarios ran it.' },
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
