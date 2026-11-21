/**
 * H3 and the protected-row changes a release's own signed bundles bring (contract C3, "Rows a release changes"): the
 * successor accepts a changed row only when its booted config differs from the previous Host's in exactly the keys the
 * two releases' bundles set differently, and tells the person afterwards.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import type { HealthExpectations } from '@delorun/home-process'
import { releaseSettingChanges, rowSettingsFact, type LayerFact, type RowSettingsChange } from '@delorun/update'
import type { BootedRow } from '../../src/delorun-bundles.ts'
import { bootRowsOf, checkHealth, HEALTH_PATH, type HostHealthFacts } from '../../src/update/host.ts'

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
})
