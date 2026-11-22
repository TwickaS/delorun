/**
 * The prompts answer as profile rows. "Ask me first" sets each prompt switch of the parity registry
 * (contract C16) to the value of Delorun's default composition, and "Ask less (like DeepSeek Harness)" to its parity value, by writing
 * the `config` of the row that `@delorun/bundle-local` inserts for the switch into the profile's `cordis.patch.yml`,
 * which loads after the bundle. "Dangerous" sets the three consent switches to their parity values, keeps the
 * permission defaults on, and sets `fullAccessEverywhere` on their row; the plugin honours it only while the grant
 * file written by dangerous mode (`delorun setup prompts` or the studio's confirmation) is valid.
 *
 * @module @delorun/setup-apply/prompt-rows
 */
import { PARITY_SWITCHES, type ParitySwitchEntry } from '@delorun/contract-parity-composition'
import { PROMPTS_OPTIONS, type PromptsAnswer } from '@delorun/contract-setup-answers'
import { readPatchRow, setPatchRow } from './patch-file.ts'

/**
 * The switches whose behaviour is a prompt or a permission default, with the row of `@delorun/bundle-local` that
 * mounts each. Several switches can share one row, as `instruction_layer_consent` and `approved_plugin_write_consent`
 * share `delorun-instruction-consent`. `fetch_guard` is a refusal and `plugin_changes_pending` holds a plugin change for
 * review instead of asking, so both stay on whichever answer the person gives; `external_agent_consent` is the person's
 * own switch in Settings → Safety → External agents, which no answer changes.
 */
export const PROMPT_SWITCH_ROWS = {
  permission_defaults: 'delorun-permission-defaults',
  instruction_layer_consent: 'delorun-instruction-consent',
  approved_plugin_write_consent: 'delorun-instruction-consent',
  mcp_add_consent: 'delorun-mcp-consent',
  scheduled_task_consent: 'delorun-schedule-consent',
} as const

/** The `delorun-permission-defaults` config key that makes full access available to every chat; the plugin also needs the grant file. */
export const FULL_ACCESS_EVERYWHERE_KEY = 'fullAccessEverywhere'

/** One patch row the prompts answer writes. */
export interface PromptRow {
  readonly id: string
  readonly config: Readonly<Record<string, boolean>>
}

/**
 * The patch rows an answer writes. A patch row replaces the bundle row's whole `config`, so the switches that share a
 * row are written as one row whose `config` sets each switch's key.
 * @param answer - the prompts answer.
 * @param registry - the switch registry; the parity registry by default.
 * @returns one row per row id of {@link PROMPT_SWITCH_ROWS}, in the order the ids first appear there, naming the
 *   config key of each switch on that row and the value the answer gives it.
 * @throws Error when a listed switch is missing from the registry or has no Config field yet.
 */
export function promptRows(answer: PromptsAnswer, registry: readonly ParitySwitchEntry[] = PARITY_SWITCHES): PromptRow[] {
  const rows = new Map<string, Record<string, boolean>>()
  for (const [switchId, rowId] of Object.entries(PROMPT_SWITCH_ROWS)) {
    const entry = registry.find(candidate => candidate.id === switchId)
    if (entry?.state !== 'built') throw new Error(`delorun setup: parity switch ${switchId} is not built, so the prompts answer cannot set it`)
    // Dangerous keeps the permission defaults on: full access is available everywhere, and a chat still starts on its workspace's preset.
    const value = answer === 'safer' || (answer === 'dangerous' && switchId === 'permission_defaults') ? entry.defaultValue : entry.parityValue
    const config = rows.get(rowId) ?? {}
    config[entry.field.key] = value
    if (switchId === 'permission_defaults') config[FULL_ACCESS_EVERYWHERE_KEY] = answer === 'dangerous'
    rows.set(rowId, config)
  }
  return [...rows].map(([id, config]) => ({ id, config }))
}

/**
 * Write the prompts answer into a profile's patch.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @param answer - the prompts answer.
 */
export function writePromptRows(patchPath: string, answer: PromptsAnswer): void {
  for (const row of promptRows(answer)) setPatchRow(patchPath, row)
}

/**
 * The prompts answer a profile's patch rows hold, as {@link writePromptRows} writes them.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @param registry - the switch registry; the parity registry by default.
 * @returns the answer whose rows the patch holds, or `undefined` when the patch holds none of the three answers' rows.
 * @throws {SetupApplyError} when the patch is not a YAML patch list.
 */
export function readPromptsRows(patchPath: string, registry: readonly ParitySwitchEntry[] = PARITY_SWITCHES): PromptsAnswer | undefined {
  return PROMPTS_OPTIONS.find(answer => promptRows(answer, registry).every((row) => {
    const held = readPatchRow(patchPath, row.id, 'delorun setup')
    return held !== undefined && Object.entries(row.config).every(([key, value]) => held[key] === value)
  }))
}
