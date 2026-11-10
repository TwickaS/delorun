/**
 * The prompts answer as profile rows. "Safer prompts" sets each prompt switch of the parity registry
 * (contract C16) to the value of Delo's default composition, and "Same as stock" to its parity value, by writing
 * the `config` of the row that `@delo/bundle-local` inserts for the switch into the profile's `cordis.patch.yml`,
 * which loads after the bundle.
 *
 * @module @delo/cli/setup/prompt-switches
 */
import { PARITY_SWITCHES, type ParitySwitchEntry } from '@delo/contract-parity-composition'
import type { PromptsAnswer } from '@delo/contract-setup-answers'
import { setPatchRow } from './writes.ts'

/**
 * The switches whose behaviour is a prompt or a permission default, with the row of `@delo/bundle-local` that
 * mounts each. `fetch_guard` is a refusal and stays on whichever answer the person gives.
 */
export const PROMPT_SWITCH_ROWS = {
  permission_defaults: 'delo-permission-defaults',
  instruction_layer_consent: 'delo-instruction-consent',
  mcp_add_consent: 'delo-mcp-consent',
  scheduled_task_consent: 'delo-schedule-consent',
} as const

/**
 * The patch rows an answer writes.
 * @param answer - the prompts answer.
 * @param registry - the switch registry; the parity registry by default.
 * @returns one row per prompt switch, naming the switch's config key and the value the answer gives it.
 * @throws Error when a listed switch is missing from the registry or has no Config field yet.
 */
export function promptRows(answer: PromptsAnswer, registry: readonly ParitySwitchEntry[] = PARITY_SWITCHES): { readonly id: string, readonly config: Readonly<Record<string, boolean>> }[] {
  return Object.entries(PROMPT_SWITCH_ROWS).map(([switchId, rowId]) => {
    const entry = registry.find(candidate => candidate.id === switchId)
    if (entry?.state !== 'built') throw new Error(`delorun setup: parity switch ${switchId} is not built, so the prompts answer cannot set it`)
    return { id: rowId, config: { [entry.field.key]: answer === 'safer' ? entry.defaultValue : entry.parityValue } }
  })
}

/**
 * Write the prompts answer into a profile's patch.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @param answer - the prompts answer.
 */
export function writePromptRows(patchPath: string, answer: PromptsAnswer): void {
  for (const row of promptRows(answer)) setPatchRow(patchPath, row)
}
