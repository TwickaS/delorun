import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { PARITY_SWITCHES, type ParitySwitchEntry } from '@delorun/contract-parity-composition'
import { promptRows, PROMPT_SWITCH_ROWS } from '../src/prompt-rows.ts'

const BUNDLE_PATCH = parse(readFileSync(new URL('../../bundle-local/cordis.patch.yml', import.meta.url), 'utf8')) as ({ id?: string, insert?: { id: string, name: string, config?: Record<string, unknown> }[] })[]
const BUNDLE_ROWS = new Map(BUNDLE_PATCH.flatMap(patch => patch.insert ?? []).map(row => [row.id, row]))

describe('the prompts answer as switch values', () => {
  it('sets each prompt switch to its Delorun default for "Ask me first" and to its parity value for "Ask less (like DeepSeek Harness)"', () => {
    const safer = promptRows('safer')
    const stock = promptRows('stock')
    expect(safer.map(row => row.id)).toEqual([...new Set(Object.values(PROMPT_SWITCH_ROWS))])
    for (const [switchId, rowId] of Object.entries(PROMPT_SWITCH_ROWS)) {
      const entry = PARITY_SWITCHES.find(candidate => candidate.id === switchId)
      expect(entry?.state).toBe('built')
      if (entry?.state !== 'built') continue
      const everywhere = switchId === 'permission_defaults' ? { fullAccessEverywhere: false } : {}
      expect(safer.find(row => row.id === rowId)?.config).toMatchObject({ [entry.field.key]: entry.defaultValue, ...everywhere })
      expect(stock.find(row => row.id === rowId)?.config).toMatchObject({ [entry.field.key]: entry.parityValue, ...everywhere })
      expect(entry.defaultValue).not.toBe(entry.parityValue)
    }
  })

  it('sets "Dangerous" to the parity value of the three consents, keeps the permission defaults on and sets fullAccessEverywhere', () => {
    const configOf = (id: string): Readonly<Record<string, boolean>> | undefined => promptRows('dangerous').find(row => row.id === id)?.config
    const valueOf = (switchId: string, which: 'defaultValue' | 'parityValue'): boolean => {
      const entry = PARITY_SWITCHES.find(candidate => candidate.id === switchId)
      return entry?.state === 'built' ? entry[which] : false
    }
    expect(configOf('delorun-permission-defaults')).toEqual({ enabled: valueOf('permission_defaults', 'defaultValue'), fullAccessEverywhere: true })
    expect(valueOf('permission_defaults', 'defaultValue')).toBe(true)
    expect(configOf('delorun-instruction-consent')).toMatchObject({ enabled: valueOf('instruction_layer_consent', 'parityValue') })
    expect(configOf('delorun-mcp-consent')).toEqual({ enabled: valueOf('mcp_add_consent', 'parityValue') })
    expect(configOf('delorun-schedule-consent')).toEqual({ enabled: valueOf('scheduled_task_consent', 'parityValue') })
  })

  it('writes the switches that share a row as one row that sets each switch\'s key', () => {
    expect(promptRows('safer').filter(row => row.id === 'delorun-instruction-consent')).toEqual([
      { id: 'delorun-instruction-consent', config: { enabled: true, approvedPluginWrites: true } },
    ])
    expect(promptRows('stock').filter(row => row.id === 'delorun-instruction-consent')).toEqual([
      { id: 'delorun-instruction-consent', config: { enabled: false, approvedPluginWrites: false } },
    ])
  })

  it('names rows that @delorun/bundle-local inserts, for the plugin and config keys the registry gives the switches on each', () => {
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
    for (const answer of ['safer', 'stock', 'dangerous'] as const) {
      expect(promptRows(answer).map(row => row.id)).not.toContain('delorun-delegation-consent')
    }
  })

  it('stops when a listed switch is not built in the registry', () => {
    const planned: ParitySwitchEntry = { id: 'permission_defaults', state: 'planned', registeredBy: 'x', defaultValue: true, parityValue: false, modelVisible: false, plannedBy: 'y' }
    expect(() => promptRows('safer', [planned])).toThrow('parity switch permission_defaults is not built')
    expect(() => promptRows('stock', [])).toThrow('parity switch permission_defaults is not built')
  })
})
