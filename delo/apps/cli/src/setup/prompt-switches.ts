/**
 * The prompts answer as profile rows. "Safer prompts" sets each prompt switch of the parity registry
 * (contract C16) to the value of Delo's default composition, and "Same as stock" to its parity value, by writing
 * the `config` of the row that `@delo/bundle-local` inserts for the switch into the profile's `cordis.patch.yml`,
 * which loads after the bundle.
 *
 * @module @delo/cli/setup/prompt-switches
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PARITY_SWITCHES, type ParitySwitchEntry } from '@delo/contract-parity-composition'
import { PROMPTS_OPTIONS, SETUP_DEFAULTS, type PromptsAnswer } from '@delo/contract-setup-answers'
import { ANSWERS_FILENAME } from './progress.ts'
import { setPatchRow } from './writes.ts'

/**
 * The switches whose behaviour is a prompt or a permission default, with the row of `@delo/bundle-local` that
 * mounts each. Several switches can share one row, as `instruction_layer_consent` and `approved_plugin_write_consent`
 * share `delo-instruction-consent`. `fetch_guard` is a refusal and `plugin_changes_pending` holds a plugin change for
 * review instead of asking, so both stay on whichever answer the person gives; `external_agent_consent` is the person's
 * own switch in Settings → External agents, which no answer changes.
 */
export const PROMPT_SWITCH_ROWS = {
  permission_defaults: 'delo-permission-defaults',
  instruction_layer_consent: 'delo-instruction-consent',
  approved_plugin_write_consent: 'delo-instruction-consent',
  mcp_add_consent: 'delo-mcp-consent',
  scheduled_task_consent: 'delo-schedule-consent',
} as const

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
    const config = rows.get(rowId) ?? {}
    config[entry.field.key] = answer === 'safer' ? entry.defaultValue : entry.parityValue
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
 * The prompts answer setup recorded for a profile, which the start holds the prompt rows to. A profile without an
 * answers record, or with one that does not name a known answer, has setup's default, "Safer prompts"; `delorun
 * setup prompts` records the answer again.
 * @param profileDirectory - the CLI profile's directory.
 * @returns the answer.
 */
export function readPromptsAnswer(profileDirectory: string): PromptsAnswer {
  const path = join(profileDirectory, ANSWERS_FILENAME)
  if (!existsSync(path)) return SETUP_DEFAULTS.prompts
  let record: { prompts?: unknown }
  try {
    record = JSON.parse(readFileSync(path, 'utf8')) as { prompts?: unknown }
  } catch (_unreadable) {
    // An unreadable record is not setup's answer; the default applies and `delorun setup prompts` rewrites it.
    return SETUP_DEFAULTS.prompts
  }
  return PROMPTS_OPTIONS.find(option => option === record.prompts) ?? SETUP_DEFAULTS.prompts
}
