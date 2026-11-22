/**
 * H3 and the protected-row changes a release's own signed bundles bring (contract C3, "Rows a release changes"): the
 * successor accepts a changed row only when its booted config differs from the previous Host's in exactly the keys the
 * two releases' bundles set differently, and tells the person afterwards.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import type { HealthExpectations } from '@delorun/home-process'
import { releaseSettingChanges, rowSettingsFact, type LayerFact, type RowSettingsChange } from '@delorun/update'
import type { BootedRow } from '../../src/delorun-bundles.ts'
import { appliedReachConfig } from '../../src/reach/host.ts'
import { bootRowsOf, checkHealth, HEALTH_PATH, personRowsOf, withAppliedConfig, type HostHealthFacts } from '../../src/update/host.ts'

const SEATS = '@delorun/plugin-agent-seats'
const PREVIOUS = '0.1.0-preview.2.3' as RuntimeVersion
const NOTE = 'Delorun 0.1.0-preview.2.5 changes the settings of the External agents row (delorun-agent-seats): turns on live agents.'

const manager: BootedRow = { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager', disabled: false, state: 'active', config: { protectedPlugins: [SEATS] } }
const seats = (config: unknown): BootedRow => ({ id: 'delorun-agent-seats', name: SEATS, disabled: false, state: 'active', config })

/**
 * A bundle layer that protects the seats plugin and gives the seats row settings.
 * @param seatsConfig - the row's keys, or `undefined` for a release without the row.
 * @returns the layer.
 */
function bundle(seatsConfig: Record<string, never | boolean | unknown[]> | undefined): LayerFact {
  return { layer: '@delorun/bundle-local', rows: [], settings: [rowSettingsFact('plugin-manager', undefined, { protectedPlugins: [SEATS] }), ...seatsConfig === undefined ? [] : [rowSettingsFact('delorun-agent-seats', SEATS, seatsConfig as never)]] }
}

describe('H3 and the changes a release\'s signed bundles bring', () => {
  const servers: Server[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async server => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  })

  /** @returns the port of a studio whose health route answers 204. */
  async function studio(): Promise<number> {
    const server = createServer((request, response) => { response.writeHead(request.url === HEALTH_PATH ? 204 : 401).end() })
    servers.push(server)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    return (server.address() as AddressInfo).port
  }

  /**
   * The facts of a successor Host.
   * @param port - the studio's port.
   * @param rows - its booted rows.
   * @param changes - what the signed bundles change, or what reading them did.
   * @returns the facts, and the previous versions the reader was asked for.
   */
  function facts(port: number, rows: readonly BootedRow[], changes: () => Promise<readonly RowSettingsChange[] | undefined>): { readonly facts: HostHealthFacts, readonly asked: string[] } {
    const asked: string[] = []
    return {
      asked,
      facts: { rows: () => rows, studio: () => ({ host: '127.0.0.1', port }), profileDir: '/nowhere', verifyRuntime: async () => Promise.resolve(), release: { version: '0.1.0-preview.2.5', settings: async (previous) => { asked.push(previous); return changes() } } },
    }
  }

  const expectationsFrom = (rows: readonly BootedRow[], extra: Partial<HealthExpectations> = {}): HealthExpectations => ({ namedRows: [], previousFailures: [], previousRows: bootRowsOf(rows), disabledPlugins: [], previousVersion: PREVIOUS, ...extra })
  const turnsOn = releaseSettingChanges([bundle({ seats: [] })], [bundle({ seats: [], enabled: true })])
  const failed = { passed: false, criterion: 'H3-only-named-disabled', detail: 'the settings of protected row delorun-agent-seats changed and the report did not name it' }

  it('passes a change that only the release\'s bundles brought, and says so in plain words', async () => {
    const port = await studio()
    const previous = [manager, seats({ seats: [] })]
    const read = facts(port, [manager, seats({ seats: [], enabled: true })], async () => Promise.resolve(turnsOn))
    expect(await checkHealth(read.facts, expectationsFrom(previous))).toEqual({ passed: true, rowChanges: [NOTE] })
    expect(read.asked).toEqual([PREVIOUS])
  })

  it('passes a row that had no config before, as the empty config it replaces', async () => {
    const port = await studio()
    const only = releaseSettingChanges([bundle({})], [bundle({ enabled: true })])
    const read = facts(port, [manager, seats({ enabled: true })], async () => Promise.resolve(only))
    expect(await checkHealth(read.facts, expectationsFrom([manager, seats(undefined)]))).toEqual({ passed: true, rowChanges: [NOTE] })
    expect(await checkHealth(read.facts, expectationsFrom([manager, seats({})]))).toEqual({ passed: true, rowChanges: [NOTE] })
  })

  it('does not read the bundles while every protected row is as it was', async () => {
    const port = await studio()
    const rows = [manager, seats({ seats: [] })]
    const read = facts(port, rows, async () => Promise.resolve(turnsOn))
    expect(await checkHealth(read.facts, expectationsFrom(rows))).toEqual({ passed: true })
    expect(read.asked).toEqual([])
  })

  it('fails a change that the release brought together with one more key', async () => {
    const port = await studio()
    const read = facts(port, [manager, seats({ seats: [], enabled: true, extra: 1 })], async () => Promise.resolve(turnsOn))
    expect(await checkHealth(read.facts, expectationsFrom([manager, seats({ seats: [] })]))).toEqual(failed)
  })

  it('fails a key the person set by hand to the release\'s old value, even though the release also changes it', async () => {
    const port = await studio()
    // The running release's bundle leaves `enabled` unset; the person set it to false in the home, and the target sets it true.
    const read = facts(port, [manager, seats({ seats: [], enabled: true })], async () => Promise.resolve(turnsOn))
    expect(await checkHealth(read.facts, expectationsFrom([manager, seats({ seats: [], enabled: false })]))).toEqual(failed)
  })

  it('fails a key the target boots with another value than its bundle sets', async () => {
    const port = await studio()
    const read = facts(port, [manager, seats({ seats: [], enabled: false })], async () => Promise.resolve(turnsOn))
    expect(await checkHealth(read.facts, expectationsFrom([manager, seats({ seats: [] })]))).toEqual(failed)
  })

  it('fails a row whose bundle setting did not change between the releases', async () => {
    const port = await studio()
    const same = releaseSettingChanges([bundle({ seats: [] })], [bundle({ seats: [] })])
    const read = facts(port, [manager, seats({ seats: [], enabled: true })], async () => Promise.resolve(same))
    expect(await checkHealth(read.facts, expectationsFrom([manager, seats({ seats: [] })]))).toEqual(failed)
  })

  it('fails a row that is gone, whatever the bundles say, unless the report named it', async () => {
    const port = await studio()
    const removed = releaseSettingChanges([bundle({ seats: [] })], [bundle(undefined)])
    const read = facts(port, [manager], async () => Promise.resolve(removed))
    expect(await checkHealth(read.facts, expectationsFrom([manager, seats({ seats: [] })]))).toEqual({
      passed: false, criterion: 'H3-only-named-disabled', detail: 'row delorun-agent-seats was in the profile before the update, is gone, and the report did not name it or disable its plugin',
    })
    expect(await checkHealth(read.facts, expectationsFrom([manager, seats({ seats: [] })], { bundleRows: ['delorun-agent-seats'] }))).toEqual({ passed: true })
  })

  it('fails an id that now loads another plugin, even with the previous config plus the key the release changes', async () => {
    const port = await studio()
    const swapped: BootedRow = { id: 'delorun-agent-seats', name: '@scope/other-plugin', disabled: false, state: 'active', config: { seats: [], enabled: true } }
    const read = facts(port, [manager, swapped], async () => Promise.resolve(turnsOn))
    expect(await checkHealth(read.facts, expectationsFrom([manager, seats({ seats: [] })]))).toEqual(failed)
    // The same swap with the plugin protected on this side still differs from the previous Host's plugin.
    const guarded: BootedRow = { ...manager, config: { protectedPlugins: [SEATS, '@scope/other-plugin'] } }
    const both = facts(port, [guarded, swapped], async () => Promise.resolve(turnsOn))
    expect(await checkHealth(both.facts, expectationsFrom([guarded, seats({ seats: [] })]))).toEqual(failed)
  })

  it('derives nothing for a row the two releases\' bundles load with different plugins', async () => {
    const port = await studio()
    const other = (enabled: boolean): LayerFact => ({ layer: 'b', rows: [], settings: [rowSettingsFact('plugin-manager', undefined, { protectedPlugins: [SEATS, '@scope/other-plugin'] }), rowSettingsFact('delorun-agent-seats', enabled ? '@scope/other-plugin' : SEATS, { seats: [], ...enabled ? { enabled: true } : {} })] })
    const swapped = releaseSettingChanges([other(false)], [other(true)])
    expect(swapped.map(change => change.change)).toEqual(['removed', 'added'])
    const read = facts(port, [manager, seats({ seats: [], enabled: true })], async () => Promise.resolve(swapped))
    expect(await checkHealth(read.facts, expectationsFrom([manager, seats({ seats: [] })]))).toEqual(failed)
  })

  it('derives nothing when two booted rows share the id', async () => {
    const port = await studio()
    const read = facts(port, [manager, seats({ seats: [] }), seats({ seats: [], enabled: true })], async () => Promise.resolve(turnsOn))
    expect(await checkHealth(read.facts, expectationsFrom([manager, seats({ seats: [] })]))).toEqual(failed)
  })

  it('derives nothing for a row the person\'s own patch layers touched when the previous Host booted', async () => {
    const port = await studio()
    const read = facts(port, [manager, seats({ seats: [], enabled: true })], async () => Promise.resolve(turnsOn))
    const edited = bootRowsOf([manager, seats({ seats: [] })], new Set(['delorun-agent-seats']))
    expect(edited.find(row => row.id === 'delorun-agent-seats')).toMatchObject({ personEdited: true })
    expect(await checkHealth(read.facts, { ...expectationsFrom([]), previousRows: edited })).toEqual(failed)
    const untouched = bootRowsOf([manager, seats({ seats: [] })], new Set(['another-row']))
    expect(untouched.find(row => row.id === 'delorun-agent-seats')?.personEdited).toBeUndefined()
    expect(await checkHealth(read.facts, { ...expectationsFrom([]), previousRows: untouched })).toMatchObject({ passed: true })
    const unreadable = bootRowsOf([manager, seats({ seats: [] })], 'unreadable')
    expect(unreadable.find(row => row.id === 'delorun-agent-seats')).toMatchObject({ personEdited: true })
    expect(unreadable.find(row => row.id === 'plugin-manager')?.personEdited).toBeUndefined()
  })

  it('derives nothing for a row whose config the previous Host applied while it ran', async () => {
    const port = await studio()
    const read = facts(port, [manager, seats({ seats: [], enabled: true })], async () => Promise.resolve(turnsOn))
    const handed = withAppliedConfig(bootRowsOf([manager, seats({ seats: [] })]), 'delorun-agent-seats', { seats: [] })
    expect(await checkHealth(read.facts, { ...expectationsFrom([]), previousRows: handed })).toEqual(failed)
  })

  it('checks the sandbox row\'s protection before it accepts any row', async () => {
    const port = await studio()
    const sandbox: BootedRow = { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local', disabled: false, state: 'active', config: { networkAccess: false } }
    const guarded: BootedRow = { ...manager, config: { protectedPlugins: [SEATS, '@deepseek-ai/dsh-sandbox-local'] } }
    const read = facts(port, [guarded, seats({ seats: [], enabled: false }), sandbox], async () => Promise.resolve(turnsOn))
    const verdict = await checkHealth(read.facts, { ...expectationsFrom([guarded, seats({ seats: [] }), sandbox]), previousProtection: { protectedHome: '/home/x/.delorun', protectedHomeReadable: [], deniedSockets: [], escapeSocketDirectories: [], privateTmp: true } })
    // The seats row also fails, but the weaker protection is what H3 reports first.
    expect(verdict.passed ? '' : verdict.detail).toContain('protection is weaker than before the update')
    expect(read.asked).toEqual([])
  })

  it('derives nothing when the bundles cannot be verified or read, when the reader answers none or the handover names no previous release', async () => {
    const port = await studio()
    const rows = [manager, seats({ seats: [], enabled: true })]
    const previous = [manager, seats({ seats: [] })]
    const unverifiable = facts(port, rows, async () => Promise.reject(new Error('file app/x differs')))
    expect(await checkHealth(unverifiable.facts, expectationsFrom(previous))).toEqual(failed)
    const none = facts(port, rows, async () => Promise.resolve(undefined))
    expect(await checkHealth(none.facts, expectationsFrom(previous))).toEqual(failed)
    const unnamed = facts(port, rows, async () => Promise.resolve(turnsOn))
    expect(await checkHealth(unnamed.facts, { ...expectationsFrom(previous), previousVersion: undefined })).toEqual(failed)
    expect(unnamed.asked).toEqual([])
    const withoutRelease: HostHealthFacts = { rows: unnamed.facts.rows, studio: unnamed.facts.studio, profileDir: '/nowhere', verifyRuntime: unnamed.facts.verifyRuntime }
    expect(await checkHealth(withoutRelease, expectationsFrom(previous))).toEqual(failed)
  })

  it('still fails a weaker sandbox protection when the same update brought the row\'s change', async () => {
    const port = await studio()
    const sandboxManager: BootedRow = { ...manager, config: { protectedPlugins: ['@deepseek-ai/dsh-sandbox-local'] } }
    const sandbox = (config: unknown): BootedRow => ({ id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local', disabled: false, state: 'active', config })
    const layer = (config: Record<string, unknown>): LayerFact => ({ layer: 'b', rows: [], settings: [rowSettingsFact('plugin-manager', undefined, { protectedPlugins: ['@deepseek-ai/dsh-sandbox-local'] }), rowSettingsFact('sandbox', '@deepseek-ai/dsh-sandbox-local', config as never)] })
    const changes = releaseSettingChanges([layer({ networkAccess: false })], [layer({ networkAccess: false, privateTmp: true })])
    const wide = { protectedHome: '/home/x/.delorun', protectedHomeReadable: [], deniedSockets: ['/run/a.sock'], escapeSocketDirectories: [], privateTmp: false }
    const before = [sandboxManager, sandbox({ networkAccess: false, ...wide })]
    const after = [sandboxManager, sandbox({ networkAccess: false, ...wide, deniedSockets: [], privateTmp: true })]
    const read = facts(port, after, async () => Promise.resolve(changes))
    const verdict = await checkHealth(read.facts, { ...expectationsFrom(before), previousProtection: { ...wide, protectedHomeReadable: [], escapeSocketDirectories: [] } })
    expect(verdict.passed).toBe(false)
    expect(verdict.passed ? '' : verdict.detail).toContain('protection is weaker than before the update')
  })

  describe('H3 after the previous Host applied a reach option while it ran', () => {
    const REACH = '@delorun/reach'
    const reachManager: BootedRow = { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager', disabled: false, state: 'active', config: { protectedPlugins: [REACH, SEATS] } }
    const reach = (config: unknown): BootedRow => ({ id: 'delorun-reach', name: REACH, disabled: false, state: 'active', config })
    const layer = (grace: number, live = false): LayerFact => ({
      layer: '@delorun/bundle-local',
      rows: [],
      settings: [rowSettingsFact('plugin-manager', undefined, { protectedPlugins: [REACH, SEATS] }), rowSettingsFact('delorun-reach', REACH, { enabled: true, grace }), rowSettingsFact('delorun-agent-seats', SEATS, live ? { seats: [], enabled: true } : { seats: [] })],
    })
    const plain = seats({ seats: [] })
    const option = { enabled: true, address: 'https://home.example.ts.net', servePort: 443, listenerPort: 31318, serveCheckIntervalMs: 60000, elevationMinutes: 15 }
    const booted = { enabled: true, grace: 1, tailscalePrivate: { enabled: false, address: '', servePort: 443 } }
    // `delorun reach on` wrote the whole option into the profile's patch; the running Host applied it and handed its hash over.
    const handed = withAppliedConfig(bootRowsOf([reachManager, reach(booted), plain], new Set(['delorun-reach'])), 'delorun-reach', appliedReachConfig(booted, option))
    const restated = { ...booted, tailscalePrivate: option }
    const unnamed = { passed: false, criterion: 'H3-only-named-disabled', detail: 'the settings of protected row delorun-reach changed and the report did not name it' }

    it('passes without deriving the reach row, whatever else the release changes', async () => {
      const port = await studio()
      const read = facts(port, [reachManager, reach(restated), seats({ seats: [], enabled: true })], async () => Promise.resolve(releaseSettingChanges([layer(5)], [layer(5, true)])))
      expect(await checkHealth(read.facts, { ...expectationsFrom([]), previousRows: handed })).toEqual({ passed: true, rowChanges: [NOTE] })
    })

    it('still fails an unnamed hand edit of the reach row after the handover, even one the release\'s own change would explain', async () => {
      const port = await studio()
      const brought = releaseSettingChanges([layer(1)], [layer(2)])
      const edited = facts(port, [reachManager, reach({ ...restated, grace: 2 }), plain], async () => Promise.resolve(brought))
      expect(await checkHealth(edited.facts, { ...expectationsFrom([]), previousRows: handed })).toEqual(unnamed)
      const another = facts(port, [reachManager, reach({ ...restated, other: 1 }), plain], async () => Promise.resolve(brought))
      expect(await checkHealth(another.facts, { ...expectationsFrom([]), previousRows: handed })).toEqual(unnamed)
    })

    it('would derive that change for the same row had the Host handed it over without the mark, which is what the mark prevents', async () => {
      const port = await studio()
      const unmarked = handed.map(({ personEdited: _marked, ...row }) => row)
      const read = facts(port, [reachManager, reach({ ...restated, grace: 2 }), plain], async () => Promise.resolve(releaseSettingChanges([layer(1)], [layer(2)])))
      expect(await checkHealth(read.facts, { ...expectationsFrom([]), previousRows: unmarked })).toMatchObject({ passed: true })
    })

    it('passes when the report names the reach row', async () => {
      const port = await studio()
      const read = facts(port, [reachManager, reach({ ...restated, other: 1 }), plain], async () => Promise.resolve(undefined))
      expect(await checkHealth(read.facts, { ...expectationsFrom([]), namedRows: ['delorun-reach'], previousRows: handed })).toEqual({ passed: true })
    })
  })
})

describe('personRowsOf', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  /**
   * A home with a profile whose patch files hold the given text.
   * @param profilePatch - the profile patch's text.
   * @param homePatch - the home patch's text, when the home has one.
   * @returns the home.
   */
  function homeWith(profilePatch: string, homePatch?: string): string {
    const home = mkdtempSync(join(tmpdir(), 'dpr-'))
    homes.push(home)
    mkdirSync(join(home, 'profiles', 'default'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'default', 'package.json'), JSON.stringify({ name: 'profile', dsh: { profile: { bundles: [] } } }))
    writeFileSync(join(home, 'profiles', 'default', 'cordis.patch.yml'), profilePatch)
    if (homePatch !== undefined) writeFileSync(join(home, 'cordis.patch.yml'), homePatch)
    return home
  }

  it('names the rows the profile patch inserts and the rows either patch changes', () => {
    const home = homeWith('- insert:\n    - id: mine\n      name: plugin-mine\n- id: delorun-agent-seats\n  config: { enabled: true }\n', '- id: delorun-reach\n  config: { enabled: false }\n')
    expect(personRowsOf(home, 'default')).toEqual(new Set(['mine', 'delorun-agent-seats', 'delorun-reach']))
  })

  it('names no row when the patches are empty, and answers unreadable for a patch that is not a list', () => {
    expect(personRowsOf(homeWith('[]\n'), 'default')).toEqual(new Set())
    expect(personRowsOf(homeWith('not: a list\n'), 'default')).toBe('unreadable')
  })
})
