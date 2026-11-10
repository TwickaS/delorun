import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { PARITY_SWITCHES, type ParitySwitchEntry } from '@delo/contract-parity-composition'
import { promptRows, PROMPT_SWITCH_ROWS } from '../../src/setup/prompt-switches.ts'

const BUNDLE_PATCH = parse(readFileSync(new URL('../../../../packages/bundle-local/cordis.patch.yml', import.meta.url), 'utf8')) as ({ id?: string, insert?: { id: string, name: string, config?: Record<string, unknown> }[] })[]
const BUNDLE_ROWS = new Map(BUNDLE_PATCH.flatMap(patch => patch.insert ?? []).map(row => [row.id, row]))

describe('the prompts answer as switch values', () => {
  it('sets each prompt switch to its Delo default for "Safer prompts" and to its parity value for "Same as stock"', () => {
    const safer = promptRows('safer')
    const stock = promptRows('stock')
    expect(safer).toHaveLength(Object.keys(PROMPT_SWITCH_ROWS).length)
    for (const [switchId, rowId] of Object.entries(PROMPT_SWITCH_ROWS)) {
      const entry = PARITY_SWITCHES.find(candidate => candidate.id === switchId)
      expect(entry?.state).toBe('built')
      if (entry?.state !== 'built') continue
      expect(safer.find(row => row.id === rowId)?.config).toEqual({ [entry.field.key]: entry.defaultValue })
      expect(stock.find(row => row.id === rowId)?.config).toEqual({ [entry.field.key]: entry.parityValue })
      expect(entry.defaultValue).not.toBe(entry.parityValue)
    }
  })

  it('names rows that @delo/bundle-local inserts, for the plugin and config key the registry gives each switch', () => {
    for (const [switchId, rowId] of Object.entries(PROMPT_SWITCH_ROWS)) {
      const entry = PARITY_SWITCHES.find(candidate => candidate.id === switchId)
      const row = BUNDLE_ROWS.get(rowId)
      expect(row, rowId).toBeDefined()
      if (entry?.state !== 'built' || row === undefined) continue
      expect(row.name).toBe(entry.field.module)
      expect(Object.keys(row.config ?? {})).toEqual([entry.field.key])
    }
  })

  it('stops when a listed switch is not built in the registry', () => {
    const planned: ParitySwitchEntry = { id: 'permission_defaults', state: 'planned', registeredBy: 'x', defaultValue: true, parityValue: false, modelVisible: false, plannedBy: 'y' }
    expect(() => promptRows('safer', [planned])).toThrow('parity switch permission_defaults is not built')
    expect(() => promptRows('stock', [])).toThrow('parity switch permission_defaults is not built')
  })
})
