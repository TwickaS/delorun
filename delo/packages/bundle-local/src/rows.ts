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
  /** The inserted row, present and disabled. */
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
    id: 'fetch-guard',
    kind: 'added',
    reason: 'web_fetch refuses loopback, link-local, private-network, unique-local, shared, multicast and reserved targets before each connection opens, so a page cannot make the fetch reach a service on the person\'s own machine or network.',
    parity: { kind: 'disabled', reason: 'Recorded fetch scenarios call loopback fixtures, which the guard refuses; the row is present and disabled, so their replay keeps upstream\'s unguarded fetch.' },
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
