/**
 * The parity overlay held against the registry and against `@delo/bundle-local`.
 * A switch row names an entry `id`, the module that entry mounts as `name`,
 * and a `config` holding only built switches of that module at their parity
 * values. A built switch the overlay does not set is listed in
 * {@link DEFAULT_PARITY} with the reason a row cannot set it; its Config
 * default is its parity value, which `registryErrors` checks. The overlay also
 * mounts `@delo/bundle-local`: it restates each patch of that bundle in the
 * parity form its `LOCAL_ROWS` entry gives, which {@link localBundleErrors}
 * checks against the bundle's own patch file.
 *
 * @module @delo/tools/parity/composition/overlay
 */
import { isDeepStrictEqual } from 'node:util'
import yaml from 'js-yaml'
import { LOCAL_ROWS, parityPatches, type PatchRow } from '@delo/bundle-local/rows'
import type { BuiltParitySwitch, ParitySwitchEntry, ParitySwitchId } from '@delo/contract-parity-composition'

/**
 * The built switches the overlay leaves to their Config default, each with the reason. A Cordis patch row replaces
 * an entry's whole `config` and reaches only rows of the root tree.
 */
export const DEFAULT_PARITY: Readonly<Partial<Record<ParitySwitchId, string>>> = {
  preset_inspect: 'its row sits in each Web preset\'s plugin list, which a patch reaches only by replacing the whole preset row',
  container_denial_marker: 'the bundles and the root configurations set sandbox-policy\'s mode and workspace root, which a row would erase',
  sandbox_protected_reads: 'a presence switch: the overlay leaves the sandbox row to upstream, which sets no protectedHome, so no row can set it to its parity value',
  default_workspace_directory: 'a presence switch: the overlay leaves the workspace-controller row to upstream, which sets no defaultWorkspaceDirectory, so no row can set it to its parity value',
  fetch_guard: 'the shipped composition mounts the plugin through @delo/bundle-local\'s inserted row, and the overlay restates that row disabled, so no row of the root tree mounts the plugin; the parity composition leaves the fetchGuard service unmounted, and the provider reads its absence per hop and runs unguarded',
  doctor: 'only the doctor profile mounts the app, and the replay starts no doctor process',
  studio_additions: 'no profile the replay runs mounts @delo/bundle-studio, so the theme row that holds the switch is absent and every studio plugin, which requires the theme\'s deloStudio service, stays unmounted',
  rename_workspace_tool: 'no shipped profile or bundle mounts the workspaces plugin, so no row of the root tree holds the switch; the parity composition registers no rename_workspace tool',
  main_chat: 'no shipped profile or bundle mounts the main chat, an experimental plugin a person adds',
  mcp_add_consent: 'the shipped composition mounts the plugin through @delo/bundle-local\'s inserted row, and the overlay restates that row disabled, so no row of the root tree mounts the plugin; the parity composition leaves the mcpAddConsent service unmounted, and the mcp-client starts every configured server as upstream does',
  external_agent_consent: 'the shipped composition mounts the plugin through @delo/bundle-local\'s inserted row, and the overlay restates that row disabled, so no row of the root tree mounts the plugin; the parity composition leaves the delegationConsent service unmounted, and every external provider starts and describes itself as upstream\'s does',
  reach: 'the shipped composition mounts the service through @delo/bundle-local\'s inserted row, and the overlay restates that row disabled, so no row of the root tree mounts it; the parity composition registers no reach provider, opens no remote listener and answers no reach route, as upstream does',
  permission_defaults: 'the shipped composition mounts the plugin through @delo/bundle-local\'s inserted row, and the overlay restates that row disabled, so no row of the root tree mounts the plugin; the parity composition leaves the permissionDefaults service and its sandbox-mode guard unmounted, so the deployment default reaches every new chat and every mode switch is recorded, as upstream records it',
  instruction_layer_consent: 'the shipped composition mounts the plugin through @delo/bundle-local\'s inserted row, and the overlay restates that row disabled, so no row of the root tree mounts the plugin; the parity composition leaves the writeConsent service unmounted, and the mutating tools run unasked, as upstream runs them',
  approved_plugin_write_consent: 'the shipped composition mounts the plugin through @delo/bundle-local\'s inserted row, and the overlay restates that row disabled, so no row of the root tree mounts the plugin; the parity composition registers no listener for writes to approved plugins, and the mutating tools write there unasked, as upstream writes',
  scheduled_task_consent: 'the shipped composition mounts the plugin through @delo/bundle-local\'s inserted row, and the overlay restates that row disabled, so no row of the root tree mounts the consent plugin; the parity composition leaves the scheduleConsent service unmounted, and approvals and deliveries keep upstream\'s text and behaviour',
  one_time_launch_tokens: 'the connection row carries the web bundle\'s trustedHosts expression, which a row would erase; the overlay leaves @delo/bundle-local\'s patch of the row out, so upstream\'s reusable process token signs in, as the recorded web scenarios signed in',
  update_turn_refusal: 'the shipped composition mounts the plugin through @delo/bundle-local\'s inserted row, and the overlay restates that row disabled, so no row of the root tree mounts the plugin; the parity composition leaves the deloTurnGate service unmounted, and every turn starts as upstream starts it',
  update_check: 'the shipped composition mounts the plugin through @delo/bundle-local\'s inserted row, and the overlay restates that row disabled, so no row of the root tree mounts the plugin; the parity composition leaves the deloUpdateCheck service and its route unmounted, so no check runs, as in stock DSH',
  plugin_changes_pending: 'the shipped composition mounts the plugin through @delo/bundle-local\'s inserted row, and the overlay restates that row disabled, so no row of the root tree mounts the plugin; the parity composition registers no plugin_manager listener or guard, and the tool installs and removes as upstream does, behind its own approval',
}

/** One overlay row, as parsed. */
export interface OverlayRow {
  readonly id: string
  readonly name: string
  readonly config: Readonly<Record<string, unknown>>
}

/** `@delo/bundle-local`'s patch file, which the overlay restates in its parity form. */
export const LOCAL_BUNDLE_PATCH_PATH = 'delo/packages/bundle-local/cordis.patch.yml'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The `!!js` tag of Cordis patch files, kept as its source text, as Cordis's include parses it. */
const JS_EXPRESSION = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: string) => ({ __jsExpr: data }),
})
const PATCH_SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_EXPRESSION])

/** The overlay split into its switch rows and its restatement of `@delo/bundle-local`. */
export interface ParsedOverlay {
  readonly switches: OverlayRow[]
  readonly localBundle: PatchRow[]
}

/**
 * Whether a patch belongs to `@delo/bundle-local`: an id patch of a row it changes, or an insert of rows it adds.
 * @param row - one overlay patch.
 * @returns true for the bundle's patches.
 */
function isLocalBundlePatch(row: Record<string, unknown>): boolean {
  const listed = (id: unknown, kind: 'changed' | 'added'): boolean => LOCAL_ROWS.some(entry => entry.kind === kind && entry.id === id)
  if ('id' in row) return listed(row['id'], 'changed')
  const insert = row['insert']
  return Array.isArray(insert) && insert.length > 0 && insert.every((entry: unknown) => isRecord(entry) && listed(entry['id'], 'added'))
}

/**
 * Parse a Cordis patch file with its `!!js` values kept.
 * @param text - the file's YAML.
 * @param what - the file, named in the error.
 * @returns its patches.
 * @throws Error when it is not a list of mappings.
 */
export function parsePatchFile(text: string, what: string): Record<string, unknown>[] {
  const parsed: unknown = yaml.load(text, { schema: PATCH_SCHEMA })
  if (!Array.isArray(parsed)) throw new Error(`${what} is a list of patch rows`)
  return parsed.map((row: unknown, index) => {
    if (!isRecord(row)) throw new Error(`${what} row ${String(index)} is not a mapping`)
    return row
  })
}

/**
 * Split the overlay into its switch rows and its restatement of `@delo/bundle-local`.
 * @param text - the overlay's YAML.
 * @returns the switch rows and the bundle's patches, each in file order.
 * @throws Error when a switch row is not a row with a string `id`, a string `name`, an object `config` and no other key.
 */
export function readOverlay(text: string): ParsedOverlay {
  const switches: OverlayRow[] = []
  const localBundle: PatchRow[] = []
  parsePatchFile(text, 'the parity overlay').forEach((row, index) => {
    if (isLocalBundlePatch(row)) {
      localBundle.push(row)
      return
    }
    const extra = Object.keys(row).filter(key => !['id', 'name', 'config'].includes(key))
    if (extra.length > 0) throw new Error(`parity overlay row ${String(index)} sets ${extra.join(', ')}; a row sets only switch values in config`)
    const { id, name, config } = row
    if (typeof id !== 'string' || typeof name !== 'string' || !isRecord(config)) {
      throw new Error(`parity overlay row ${String(index)} needs a string id, a string name and a config mapping`)
    }
    switches.push({ id, name, config })
  })
  return { switches, localBundle }
}

/**
 * Every difference between the overlay's restatement of `@delo/bundle-local` and the parity form of the bundle's
 * own patch file.
 * @param overlay - the overlay's `@delo/bundle-local` patches, from {@link readOverlay}.
 * @param bundlePatchText - the text of {@link LOCAL_BUNDLE_PATCH_PATH}.
 * @returns one message per missing, extra or different patch; empty when the overlay mounts the bundle in its parity form.
 */
export function localBundleErrors(overlay: readonly PatchRow[], bundlePatchText: string): string[] {
  let expected: PatchRow[]
  try {
    expected = parityPatches(parsePatchFile(bundlePatchText, LOCAL_BUNDLE_PATCH_PATH))
  } catch (error) {
    return [`${LOCAL_BUNDLE_PATCH_PATH}: ${error instanceof Error ? error.message : String(error)}`]
  }
  const label = (patch: PatchRow | undefined): string => patch === undefined ? 'nothing' : JSON.stringify(patch)
  const errors: string[] = []
  for (let index = 0; index < Math.max(expected.length, overlay.length); index += 1) {
    if (!isDeepStrictEqual(overlay[index], expected[index])) {
      errors.push(`parity overlay: @delo/bundle-local patch ${String(index)} is ${label(overlay[index])}, not its parity form ${label(expected[index])}`)
    }
  }
  return errors
}

/**
 * Parse the overlay's switch rows.
 * @param text - the overlay's YAML.
 * @returns its switch rows, leaving out its restatement of `@delo/bundle-local`.
 * @throws Error when a switch row is not a row with a string `id`, a string `name`, an object `config` and no other key.
 */
export function parseOverlay(text: string): OverlayRow[] {
  return readOverlay(text).switches
}

/**
 * Every disagreement between the overlay and the registry.
 * @param rows - the overlay's rows.
 * @param registry - the switch registry.
 * @returns one message per disagreement; empty when the overlay sets each switch it can and only those.
 */
export function overlayErrors(rows: readonly OverlayRow[], registry: readonly ParitySwitchEntry[]): string[] {
  const built = registry.filter((entry): entry is BuiltParitySwitch => entry.state === 'built')
  const errors: string[] = []
  const set = new Set<string>()
  for (const row of rows) {
    const switches = built.filter(entry => entry.field.module === row.name)
    if (switches.length === 0) errors.push(`parity overlay row ${row.id}: ${row.name} holds no built C16 switch`)
    for (const [key, value] of Object.entries(row.config)) {
      const entry = switches.find(candidate => candidate.field.key === key)
      if (entry === undefined) {
        errors.push(`parity overlay row ${row.id}: ${key} is not a C16 switch of ${row.name}`)
        continue
      }
      if (value !== entry.parityValue) errors.push(`parity overlay row ${row.id}: ${key} is ${JSON.stringify(value)}, not the parity value of ${entry.id} (${String(entry.parityValue)})`)
      set.add(entry.id)
    }
  }
  for (const entry of built) {
    const reason = Object.entries(DEFAULT_PARITY).find(([id]) => id === entry.id)?.[1]
    if (set.has(entry.id) && reason !== undefined) errors.push(`${entry.id}: the overlay sets it, so it leaves DEFAULT_PARITY`)
    if (!set.has(entry.id) && reason === undefined) errors.push(`${entry.id}: the overlay does not set it; add a row, or list it in DEFAULT_PARITY with the reason a row cannot`)
  }
  for (const id of Object.keys(DEFAULT_PARITY)) {
    if (!built.some(entry => entry.id === id)) errors.push(`DEFAULT_PARITY names ${id}, which is no built C16 switch`)
  }
  return errors
}
