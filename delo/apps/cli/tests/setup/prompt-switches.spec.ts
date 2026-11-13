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
    expect(safer.map(row => row.id)).toEqual([...new Set(Object.values(PROMPT_SWITCH_ROWS))])
    for (const [switchId, rowId] of Object.entries(PROMPT_SWITCH_ROWS)) {
      const entry = PARITY_SWITCHES.find(candidate => candidate.id === switchId)
      expect(entry?.state).toBe('built')
      if (entry?.state !== 'built') continue
      expect(safer.find(row => row.id === rowId)?.config[entry.field.key], switchId).toBe(entry.defaultValue)
      expect(stock.find(row => row.id === rowId)?.config[entry.field.key], switchId).toBe(entry.parityValue)
      expect(entry.defaultValue).not.toBe(entry.parityValue)
    }
  })

  it('writes the switches that share a row as one row that sets each switch\'s key', () => {
    expect(promptRows('safer').filter(row => row.id === 'delo-instruction-consent')).toEqual([
      { id: 'delo-instruction-consent', config: { enabled: true, approvedPluginWrites: true } },
    ])
    expect(promptRows('stock').filter(row => row.id === 'delo-instruction-consent')).toEqual([
      { id: 'delo-instruction-consent', config: { enabled: false, approvedPluginWrites: false } },
    ])
  })

  it('names rows that @delo/bundle-local inserts, for the plugin and config keys the registry gives the switches on each', () => {
    const keysByRow = new Map<string, string[]>()
    for (const [switchId, rowId] of Object.entries(PROMPT_SWITCH_ROWS)) {
      const entry = PARITY_SWITCHES.find(candidate => candidate.id === switchId)
      const row = BUNDLE_ROWS.get(rowId)
      expect(row, rowId).toBeDefined()
      if (entry?.state !== 'built' || row === undefined) continue
      expect(row.name).toBe(entry.field.module)
      keysByRow.set(rowId, [...keysByRow.get(rowId) ?? [], entry.field.key])
    }
    for (const [rowId, keys] of keysByRow) expect(Object.keys(BUNDLE_ROWS.get(rowId)?.config ?? {}).sort(), rowId).toEqual(keys.sort())
  })

  it('leaves the external-agent consent, the person\'s own switch in Settings, out of both answers', () => {
    for (const answer of ['safer', 'stock'] as const) {
      expect(promptRows(answer).map(row => row.id)).not.toContain('delo-delegation-consent')
    }
  })

  it('stops when a listed switch is not built in the registry', () => {
    const planned: ParitySwitchEntry = { id: 'permission_defaults', state: 'planned', registeredBy: 'x', defaultValue: true, parityValue: false, modelVisible: false, plannedBy: 'y' }
    expect(() => promptRows('safer', [planned])).toThrow('parity switch permission_defaults is not built')
    expect(() => promptRows('stock', [])).toThrow('parity switch permission_defaults is not built')
  })
})
