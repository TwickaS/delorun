/**
 * The settings two releases' signed bundles give protected rows: which differ, how the report words them, and what the
 * health check derives from them.
 */
import { describe, expect, it } from 'vitest'
import { buildUpdateReport, builtReport, previousConfigsOf, protectedPluginsOfLayers, releaseSettingChanges, reasonMessage, rowSettingsFact, settingsNote, type LayerFact } from '../src/index.ts'
import { BUNDLE_FACTS, input, target } from './support.ts'

const SEATS = '@delorun/plugin-agent-seats'

/**
 * A bundle layer that protects a plugin and gives rows settings.
 * @param settings - the rows' settings.
 * @param protectedPlugins - the plugins `plugin-manager` protects.
 * @returns the layer.
 */
function layer(settings: LayerFact['settings'], protectedPlugins: readonly string[] = [SEATS]): LayerFact {
  return { layer: '@delorun/bundle-local', rows: [], settings: [rowSettingsFact('plugin-manager', undefined, { protectedPlugins }), ...settings ?? []] }
}

const SEATS_BEFORE = layer([rowSettingsFact('delorun-agent-seats', SEATS, { seats: [] })])
const SEATS_AFTER = layer([rowSettingsFact('delorun-agent-seats', SEATS, { seats: [], enabled: true })])

describe('releaseSettingChanges', () => {
  it('names the key a release turns on in a protected row', () => {
    expect(releaseSettingChanges([SEATS_BEFORE], [SEATS_AFTER])).toEqual([
      { id: 'delorun-agent-seats', plugin: SEATS, layer: '@delorun/bundle-local', change: 'changed', keys: [{ key: 'enabled', after: true }] },
    ])
  })

  it('names nothing when both releases give the row the same settings, whatever the key order', () => {
    const same = layer([rowSettingsFact('delorun-agent-seats', SEATS, { enabled: true, seats: [{ b: 1, a: 2 }] })])
    const reordered = layer([rowSettingsFact('delorun-agent-seats', SEATS, { seats: [{ a: 2, b: 1 }], enabled: true })])
    expect(releaseSettingChanges([same], [reordered])).toEqual([])
  })

  it('tells a key set to null from a key the bundle does not set', () => {
    const unset = layer([rowSettingsFact('delorun-agent-seats', SEATS, {})])
    const nulled = layer([rowSettingsFact('delorun-agent-seats', SEATS, { limit: null })])
    expect(releaseSettingChanges([unset], [nulled])[0]?.keys).toEqual([{ key: 'limit', after: null }])
    expect(releaseSettingChanges([nulled], [unset])[0]?.keys).toEqual([{ key: 'limit', before: null }])
  })

  it('names a protected row the target adds and one it removes, each with all its settings', () => {
    const none = layer([])
    expect(releaseSettingChanges([none], [SEATS_AFTER])).toEqual([
      { id: 'delorun-agent-seats', plugin: SEATS, layer: '@delorun/bundle-local', change: 'added', keys: [{ key: 'enabled', after: true }, { key: 'seats', after: [] }] },
    ])
    expect(releaseSettingChanges([SEATS_AFTER], [none])).toEqual([
      { id: 'delorun-agent-seats', plugin: SEATS, layer: '@delorun/bundle-local', change: 'removed', keys: [{ key: 'enabled', before: true }, { key: 'seats', before: [] }] },
    ])
  })

  it('leaves out a row whose plugin neither release protects, such as the prompt-wording row', () => {
    const wording = (enabled: boolean): LayerFact => layer([rowSettingsFact('delorun-prompt-wording', '@delorun/bundle-local/prompt-wording', { enabled })])
    expect(releaseSettingChanges([layer([])], [wording(true)])).toEqual([])
    expect(releaseSettingChanges([wording(false)], [wording(true)])).toEqual([])
  })

  it('protects a plugin that only the target\'s list names, and one only the running release\'s names', () => {
    const before = layer([rowSettingsFact('row-x', 'plugin-x', { a: 1 })], [])
    const after = layer([rowSettingsFact('row-x', 'plugin-x', { a: 2 })], ['plugin-x'])
    expect(releaseSettingChanges([before], [after])).toHaveLength(1)
    expect(releaseSettingChanges([after], [before])).toHaveLength(1)
  })

  it('merges a later layer\'s update entry over the layer that inserted the row', () => {
    const inserted = layer([rowSettingsFact('delorun-agent-seats', SEATS, { seats: [] })])
    const update: LayerFact = { layer: '@delorun/bundle-studio', rows: [], settings: [rowSettingsFact('delorun-agent-seats', undefined, { enabled: true })] }
    expect(releaseSettingChanges([inserted], [inserted, update])).toMatchObject([{ id: 'delorun-agent-seats', layer: '@delorun/bundle-studio', change: 'changed', keys: [{ key: 'enabled', after: true }] }])
  })

  it('names a row another plugin loads in the target as a removed row and an added row, never as changed settings', () => {
    const other = layer([rowSettingsFact('delorun-agent-seats', '@scope/other', { seats: [], enabled: true })], [SEATS, '@scope/other'])
    expect(releaseSettingChanges([SEATS_BEFORE], [other])).toEqual([
      { id: 'delorun-agent-seats', plugin: SEATS, layer: '@delorun/bundle-local', change: 'removed', keys: [{ key: 'seats', before: [] }] },
      { id: 'delorun-agent-seats', plugin: '@scope/other', layer: '@delorun/bundle-local', change: 'added', keys: [{ key: 'enabled', after: true }, { key: 'seats', after: [] }] },
    ])
  })

  it('reads a layer that carries no settings as holding none', () => {
    expect(releaseSettingChanges([{ layer: 'a', rows: [] }], [{ layer: 'a', rows: [] }])).toEqual([])
    expect(protectedPluginsOfLayers([{ layer: 'a', rows: [] }]).size).toBe(0)
    expect(protectedPluginsOfLayers([layer([])])).toEqual(new Set([SEATS]))
  })
})

describe('the report', () => {
  const [change] = releaseSettingChanges([SEATS_BEFORE], [SEATS_AFTER])
  const bundles = { ...BUNDLE_FACTS, layers: [SEATS_AFTER], runningLayers: [SEATS_BEFORE] }
  const report = buildUpdateReport(input({ target: target({ bundles }) }))
  const item = report.items.find(candidate => candidate.reason === 'row-settings-changed')

  it('names the changed row as a verified, changed row item', () => {
    expect(item).toEqual({
      kind: 'row', subject: { id: 'delorun-agent-seats', name: 'delorun-agent-seats', layer: '@delorun/bundle-local' }, reason: 'row-settings-changed', effect: 'changed', verification: 'verified',
      detail: { settings: { change: 'changed', keys: [{ key: 'enabled', after: true }] } }, actions: [],
    })
  })

  it('words the change plainly, with the row\'s title and no JSON', () => {
    expect(reasonMessage(item!, report)).toBe(`Delorun ${report.to.delorun} changes the settings of the External agents row (delorun-agent-seats): turns on live agents.`)
    expect(settingsNote(change!, '0.1.0-preview.2.5')).toBe('Delorun 0.1.0-preview.2.5 changes the settings of the External agents row (delorun-agent-seats): turns on live agents.')
  })

  it('does not name a changed row to the health check, which derives it, and names a removed row', () => {
    expect(builtReport(input({ target: target({ bundles }) })).health.namedRows).not.toContain('delorun-agent-seats')
    expect(builtReport(input({ target: target({ bundles }) })).health.bundleRows).not.toContain('delorun-agent-seats')
    const dropped = builtReport(input({ target: target({ bundles: { ...BUNDLE_FACTS, layers: [layer([])], runningLayers: [SEATS_AFTER] } }) }))
    expect(dropped.health.bundleRows).toContain('delorun-agent-seats')
    expect(dropped.report.items.find(candidate => candidate.reason === 'row-settings-changed')).toMatchObject({ effect: 'removed' })
  })

  it('words an added and a removed row, a setting turned off and a plain value', () => {
    const words = (settings: Parameters<typeof settingsNote>[0]): string => settingsNote(settings, '1.0.0')
    const base = { id: 'row-x', plugin: 'plugin-x', layer: 'b' }
    expect(words({ ...base, change: 'added', keys: [] })).toBe('Delorun 1.0.0 adds row row-x, which Delorun protects.')
    expect(words({ ...base, change: 'removed', keys: [] })).toBe('Delorun 1.0.0 removes row row-x, which Delorun protects.')
    expect(words({ ...base, id: 'delorun-agent-seats', change: 'changed', keys: [{ key: 'enabled', before: true, after: false }] })).toContain('turns off live agents')
    expect(words({ ...base, change: 'changed', keys: [{ key: 'enabled', after: true }, { key: 'limit', after: 3 }, { key: 'mode', before: 'a', after: '/home/x/secret' }, { key: 'seats', after: [] }, { key: 'old', before: 1 }] }))
      .toBe('Delorun 1.0.0 changes the settings of row row-x: turns on the row; sets limit to 3; changes the mode setting; changes the seats setting; removes the old setting.')
  })
})

describe('previousConfigsOf', () => {
  const [change] = releaseSettingChanges([SEATS_BEFORE], [SEATS_AFTER])

  it('sets each changed key back to the running release\'s value', () => {
    expect(previousConfigsOf({ seats: [], enabled: true }, change!)).toEqual([{ seats: [] }])
  })

  it('offers an empty config and no config when nothing is left', () => {
    const only = releaseSettingChanges([layer([rowSettingsFact('delorun-agent-seats', SEATS, {})])], [layer([rowSettingsFact('delorun-agent-seats', SEATS, { enabled: true })])])[0]!
    expect(previousConfigsOf({ enabled: true }, only)).toEqual([{}, undefined])
    expect(previousConfigsOf(undefined, only)).toEqual([])
  })

  it('offers nothing when a changed key does not hold the target\'s value', () => {
    expect(previousConfigsOf({ seats: [], enabled: false }, change!)).toEqual([])
    expect(previousConfigsOf({ seats: [] }, change!)).toEqual([])
  })

  it('offers nothing for an added or removed row or a config that is not a mapping', () => {
    const added = releaseSettingChanges([layer([])], [SEATS_AFTER])[0]!
    expect(previousConfigsOf({ enabled: true, seats: [] }, added)).toEqual([])
    expect(previousConfigsOf('text', change!)).toEqual([])
    expect(previousConfigsOf([], change!)).toEqual([])
    expect(previousConfigsOf(null, change!)).toEqual([])
  })

  it('requires a key the release unsets to be unset on the target', () => {
    const unset = releaseSettingChanges([layer([rowSettingsFact('r', SEATS, { old: 1 })])], [layer([rowSettingsFact('r', SEATS, {})])])[0]!
    expect(previousConfigsOf({}, unset)).toEqual([{ old: 1 }])
    expect(previousConfigsOf({ old: 1 }, unset)).toEqual([])
  })
})
