/**
 * What a device loosens in dangerous mode is recorded before the call proceeds and set back, through the settings
 * service, when the mode ends, unless the person changed it at the computer since (C14, "Elevation").
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DangerousSettingsLedger, type SettingsFieldAccess } from '../src/dangerous-settings.ts'
import { createCondition, type ComputerOnlySwitch, type ReachAccessFacts } from '../src/reach-access.ts'
import { REACH_DEVICE } from '../src/reach-access.ts'

/** The entry id of a row that only the computer changes. */
const COMPUTER_ONLY_ROW = 'include:delorun-home-auth'

let directory = ''
let file = ''
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'delorun-dangerous-settings-'))
  file = join(directory, 'reach-dangerous-settings.json')
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

/** An in-memory settings service: the live values by namespace and field, and every write in order. */
function fakeSettings(values: Record<string, unknown>): SettingsFieldAccess & { readonly writes: unknown[]; failing: boolean } {
  const writes: unknown[] = []
  const settings = {
    writes,
    failing: false,
    read: (ns: string, field: string) => values[`${ns}.${field}`],
    write: (ns: string, field: string, value: unknown) => {
      if (settings.failing) return Promise.reject(new Error('unwritable'))
      writes.push([ns, field, value])
      values[`${ns}.${field}`] = value
      return Promise.resolve()
    },
  }
  return settings
}

const PRESET = { ns: 'permission', field: 'defaultPreset' }
const CONSENT = { ns: 'delorun-delegation-consent', field: 'enabled' }

describe('the dangerous-mode settings record', () => {
  it('sets a device\'s loosened preset and consent back when the mode ends', async () => {
    const values: Record<string, unknown> = { 'permission.defaultPreset': 'workspace-write', 'delorun-delegation-consent.enabled': true }
    const settings = fakeSettings(values)
    const ledger = new DangerousSettingsLedger(file)
    // The device loosens the preset and turns the consent off; the record is taken before the write.
    ledger.record([{ ...PRESET, written: 'danger-full-access' }, { ...CONSENT, written: false }], settings.read)
    values['permission.defaultPreset'] = 'danger-full-access'
    values['delorun-delegation-consent.enabled'] = false
    // Pins the mode check: nothing reverts while the mode holds.
    await ledger.revert(settings, () => true)
    expect(settings.writes).toEqual([])
    await ledger.revert(settings, () => false)
    expect(values).toEqual({ 'permission.defaultPreset': 'workspace-write', 'delorun-delegation-consent.enabled': true })
    expect(ledger.pending()).toBe(false)
  })

  it('keeps a lift whose settings row is not described instead of dropping it unwritten', async () => {
    const values: Record<string, unknown> = { 'permission.defaultPreset': 'workspace-write' }
    const settings = fakeSettings(values)
    let described = false
    const access: SettingsFieldAccess = { ...settings, described: () => described }
    const ledger = new DangerousSettingsLedger(file)
    ledger.record([{ ...PRESET, written: 'danger-full-access' }], settings.read)
    values['permission.defaultPreset'] = 'danger-full-access'
    // Pins the described check: an absent row reads as unset, which would pass for the person's change and drop the lift.
    await ledger.revert(access, () => false)
    expect(ledger.pending()).toBe(true)
    expect(settings.writes).toEqual([])
    described = true
    await ledger.revert(access, () => false)
    expect(values['permission.defaultPreset']).toBe('workspace-write')
    expect(ledger.pending()).toBe(false)
  })

  it('keeps what the person set at the computer since the device wrote', async () => {
    const values: Record<string, unknown> = { 'permission.defaultPreset': 'workspace-write', 'delorun-delegation-consent.enabled': true }
    const settings = fakeSettings(values)
    const ledger = new DangerousSettingsLedger(file)
    ledger.record([{ ...PRESET, written: 'danger-full-access' }, { ...CONSENT, written: false }], settings.read)
    // Pins the override rule: the person chose read-only and turned the consent back on, so neither reverts.
    values['permission.defaultPreset'] = 'read-only'
    values['delorun-delegation-consent.enabled'] = true
    await ledger.revert(settings, () => false)
    expect(settings.writes).toEqual([])
    expect(values).toEqual({ 'permission.defaultPreset': 'read-only', 'delorun-delegation-consent.enabled': true })
    expect(ledger.pending()).toBe(false)
  })

  it('keeps the first previous value across several device writes, and unsets a field that had no value', async () => {
    const values: Record<string, unknown> = { 'permission.defaultPreset': 'workspace-write' }
    const settings = fakeSettings(values)
    const ledger = new DangerousSettingsLedger(file)
    ledger.record([{ ...PRESET, written: 'danger-full-access' }], settings.read)
    values['permission.defaultPreset'] = 'danger-full-access'
    ledger.record([{ ...PRESET, written: 'read-only' }], settings.read)
    values['permission.defaultPreset'] = 'read-only'
    ledger.record([{ ...CONSENT, written: false }], settings.read)
    values['delorun-delegation-consent.enabled'] = false
    await ledger.revert(settings, () => false)
    expect(values['permission.defaultPreset']).toBe('workspace-write')
    expect(settings.writes).toContainEqual(['delorun-delegation-consent', 'enabled', undefined])
  })

  it('reverts a write whose value the call did not name whenever the field differs from its previous value', async () => {
    const values: Record<string, unknown> = { 'permission.defaultPreset': 'workspace-write' }
    const settings = fakeSettings(values)
    const ledger = new DangerousSettingsLedger(file)
    ledger.record([{ ...PRESET, written: undefined }], settings.read)
    values['permission.defaultPreset'] = 'danger-full-access'
    await ledger.revert(settings, () => false)
    expect(values['permission.defaultPreset']).toBe('workspace-write')
  })

  it('keeps a lift whose write failed and retries it, and survives a restart', async () => {
    const values: Record<string, unknown> = { 'permission.defaultPreset': 'workspace-write' }
    const settings = fakeSettings(values)
    const ledger = new DangerousSettingsLedger(file)
    ledger.record([{ ...PRESET, written: 'danger-full-access' }], settings.read)
    values['permission.defaultPreset'] = 'danger-full-access'
    settings.failing = true
    await ledger.revert(settings, () => false)
    expect(ledger.pending()).toBe(true)
    // Pins the durable record: a new run reads the lift the old one left and reverts it.
    await ledger.revert(settings, () => true)
    const reloaded = new DangerousSettingsLedger(file)
    await reloaded.load()
    expect(reloaded.pending()).toBe(true)
    settings.failing = false
    await reloaded.revert(settings, () => false)
    expect(values['permission.defaultPreset']).toBe('workspace-write')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ v: 1, lifts: [] })
  })

  it('reports each failed set-back by namespace and field, never by value, and lists what still waits', async () => {
    const values: Record<string, unknown> = { 'permission.defaultPreset': 'workspace-write', 'delorun-delegation-consent.enabled': true }
    const settings = fakeSettings(values)
    const ledger = new DangerousSettingsLedger(file)
    ledger.record([{ ...PRESET, written: 'danger-full-access' }, { ...CONSENT, written: false }], settings.read)
    values['permission.defaultPreset'] = 'danger-full-access'
    values['delorun-delegation-consent.enabled'] = false
    settings.failing = true
    const failed: unknown[] = []
    await ledger.revert(settings, () => false, lift => failed.push(lift))
    // Pins the report: one entry per failed lift, naming the field only.
    expect(failed).toEqual([PRESET, CONSENT])
    expect(ledger.waiting()).toEqual([PRESET, CONSENT])
    settings.failing = false
    await ledger.revert(settings, () => false, lift => failed.push(lift))
    expect(failed).toHaveLength(2)
    expect(ledger.waiting()).toEqual([])
  })

  it('does not revert on a retry while the mode holds again, and keeps the lift', async () => {
    const values: Record<string, unknown> = { 'permission.defaultPreset': 'workspace-write' }
    const settings = fakeSettings(values)
    const ledger = new DangerousSettingsLedger(file)
    ledger.record([{ ...PRESET, written: 'danger-full-access' }], settings.read)
    values['permission.defaultPreset'] = 'danger-full-access'
    settings.failing = true
    await ledger.revert(settings, () => false)
    settings.failing = false
    // Pins the re-check on every pass: the person turned the mode back on before the retry.
    await ledger.revert(settings, () => true)
    expect(settings.writes).toEqual([])
    expect(values['permission.defaultPreset']).toBe('danger-full-access')
    expect(ledger.pending()).toBe(true)
  })

  it('keeps what the person set after a failed set-back when the retry runs', async () => {
    const values: Record<string, unknown> = { 'permission.defaultPreset': 'workspace-write' }
    const settings = fakeSettings(values)
    const ledger = new DangerousSettingsLedger(file)
    ledger.record([{ ...PRESET, written: 'danger-full-access' }], settings.read)
    values['permission.defaultPreset'] = 'danger-full-access'
    settings.failing = true
    await ledger.revert(settings, () => false)
    values['permission.defaultPreset'] = 'read-only'
    settings.failing = false
    await ledger.revert(settings, () => false)
    // Pins the override rule on a retry: the person's later choice is not written over.
    expect(settings.writes).toEqual([])
    expect(values['permission.defaultPreset']).toBe('read-only')
    expect(ledger.pending()).toBe(false)
  })

  it('keeps a value the person set after a device unset the field, and unsets a field still left unset', async () => {
    const values: Record<string, unknown> = { 'delorun-delegation-consent.enabled': true }
    const settings = fakeSettings(values)
    const ledger = new DangerousSettingsLedger(file)
    ledger.record([{ ...CONSENT, written: undefined, unset: true }], settings.read)
    delete values['delorun-delegation-consent.enabled']
    // The person turns the consent on at the computer after the device unset it; the unset marker keeps it.
    values['delorun-delegation-consent.enabled'] = false
    await ledger.revert(settings, () => false)
    // Pins the unset marker: without it a field that differs from its previous value reverts, losing the person's choice.
    expect(settings.writes).toEqual([])
    expect(values['delorun-delegation-consent.enabled']).toBe(false)
    ledger.record([{ ...CONSENT, written: undefined, unset: true }], settings.read)
    delete values['delorun-delegation-consent.enabled']
    await ledger.revert(settings, () => false)
    expect(settings.writes).toEqual([['delorun-delegation-consent', 'enabled', false]])
  })

  it('throws and keeps no lift when the record cannot be saved', () => {
    const ledger = new DangerousSettingsLedger(join(directory, 'missing', 'record.json'))
    // Pins the synchronous save: a failed save is raised before the device's write can proceed.
    expect(() => { ledger.record([{ ...PRESET, written: 'danger-full-access' }], () => 'workspace-write') }).toThrow()
    expect(ledger.pending()).toBe(false)
  })

  it('refuses a record of another version', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, JSON.stringify({ v: 2, lifts: [] }), { mode: 0o600 })
    await expect(new DangerousSettingsLedger(file).load()).rejects.toThrow(/does not hold this version/)
  })
})

describe('the reach policy records what dangerous mode lets a device loosen', () => {
  const SWITCH: ComputerOnlySwitch = { ns: CONSENT.ns, field: CONSENT.field, label: 'the external-agent consent' }
  const LEVELS = { 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' }, 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } } as Record<string, { sandbox: string; approval: string }>
  const device = { kind: REACH_DEVICE, deviceId: 'device-1', listener: 'reach-tailscale-private' } as never

  /**
   * The policy's facts, with a list the recorded lifts go to.
   * @param mode - whether dangerous mode holds.
   * @param unlocked - whether the device holds an unlock.
   * @param seen - the lifts the policy recorded.
   * @param pageUnlocked - whether the page `page-1` holds a PIN page unlock.
   * @returns the facts.
   */
  function facts(mode: boolean, unlocked: boolean, seen: unknown[], pageUnlocked = false): ReachAccessFacts {
    return {
      unlockModeEnabled: () => false, keyRefs: () => new Set<string>(), pageUnlockOf: id => (pageUnlocked && id === 'page-1' ? { id: 'page-1' } : undefined), admitted: () => true, workspaces: () => [], liveSessions: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere',
      elevationOf: () => (unlocked ? { id: 'elevation-1' } : undefined), logElevated: () => {}, liftedSettings: (lifts) => { seen.push(...lifts); return undefined },
      computerOnlySwitches: () => [SWITCH], protectedEntryIds: () => new Set(), computerOnlyEntryIds: () => new Set([COMPUTER_ONLY_ROW]),
      defaultPermission: () => ({ namespaces: new Set(['permission']), current: LEVELS['workspace-write'], levelOf: name => LEVELS[name] }),
      dangerousMode: () => mode,
    }
  }
  const call = (args: Record<string, unknown>) => ({ action: 'settings/update' as never, resource: { kind: 'global' } as const, args })

  it('records a preset loosening and a consent turn-off of an unlocked device, with the values they set', () => {
    const seen: unknown[] = []
    const condition = createCondition(facts(true, true, seen), device)
    expect(condition(call({ ns: 'permission', patch: { defaultPreset: 'danger-full-access' } }))).toEqual({ kind: 'allow' })
    expect(condition(call({ ns: CONSENT.ns, patch: { enabled: false } }))).toEqual({ kind: 'allow' })
    expect(seen).toEqual([{ ...PRESET, written: 'danger-full-access' }, { ...CONSENT, written: false }])
  })

  it('records an unset of the consent as an unset lift', () => {
    const seen: unknown[] = []
    const condition = createCondition(facts(true, true, seen), device)
    expect(condition({ action: 'settings/mutate' as never, resource: { kind: 'global' } as const, args: { ns: CONSENT.ns, ops: [{ op: 'unset', path: ['enabled'] }] } })).toEqual({ kind: 'allow' })
    expect(seen).toEqual([{ ...CONSENT, written: undefined, unset: true }])
  })

  it('refuses the write when the record is not saved', () => {
    const seen: unknown[] = []
    const refusing: ReachAccessFacts = { ...facts(true, true, seen), liftedSettings: () => 'record-refused' }
    // Pins the refusal: without it the write proceeds with nothing to set it back.
    expect(createCondition(refusing, device)(call({ ns: CONSENT.ns, patch: { enabled: false } }))).toEqual({ kind: 'deny', reason: 'record-refused' })
  })

  it('records nothing for a locked device, with the mode off, or for a write that loosens nothing', () => {
    const seen: unknown[] = []
    const loosen = call({ ns: 'permission', patch: { defaultPreset: 'danger-full-access' } })
    expect(createCondition(facts(true, false, seen), device)(loosen)).toMatchObject({ kind: 'deny' })
    expect(createCondition(facts(false, true, seen), device)(loosen)).toMatchObject({ kind: 'deny' })
    expect(createCondition(facts(true, true, seen), device)(call({ ns: 'permission', patch: { defaultPreset: 'workspace-write' } }))).toEqual({ kind: 'allow' })
    expect(createCondition(facts(true, true, seen), device)(call({ ns: CONSENT.ns, patch: { enabled: true } }))).toEqual({ kind: 'allow' })
    expect(seen).toEqual([])
  })

  describe('under PIN mode', () => {
    const page = { kind: REACH_DEVICE, deviceId: 'device-1', listener: 'reach-tailscale-private', unlockId: 'page-1' } as never
    const loosenPreset = call({ ns: 'permission', patch: { defaultPreset: 'danger-full-access' } })
    const consentOff = call({ ns: CONSENT.ns, patch: { enabled: false } })

    // Pins A483 (never a window): with the page-unlock lift back, the unlocked page turns the consent off and loosens new chats.
    it('lets an unlocked PIN page lift nothing and record nothing, as a locked one', () => {
      for (const pageUnlocked of [true, false]) {
        const seen: unknown[] = []
        const condition = createCondition(facts(false, false, seen, pageUnlocked), page)
        expect(condition(loosenPreset), String(pageUnlocked)).toMatchObject({ kind: 'deny' })
        expect(condition(consentOff), String(pageUnlocked)).toEqual({ kind: 'deny', reason: 'loopback-required: turning the external-agent consent off' })
        expect(seen).toEqual([])
      }
    })

    it('keeps the computer-only switch on for a device that holds a code unlock but no page unlock', () => {
      // Pins the lift's condition: only dangerous mode lifts the switch, a code unlock alone does not.
      const seen: unknown[] = []
      const elevated = createCondition(facts(false, true, seen), page)
      expect(elevated(consentOff)).toEqual({ kind: 'deny', reason: 'loopback-required: turning the external-agent consent off' })
      expect(seen).toEqual([])
    })
  })
})
