/**
 * The bundles' flag index and the Host's flags: what the row refuses when it loads, what a declaration is checked
 * against, and what `isOn` answers. Each test's comment names the check whose removal makes it fail.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { previewFlagId, type PreviewFlagDeclaration } from '../src/flags.ts'
import { assertFlagsIndexed, listedFlags, readFlagIndex, type FlagBundle, type FlagIndex } from '../src/manifest.ts'
import { createPreviewFlags } from '../src/registry.ts'

const STEPS = previewFlagId('onboarding.previewSteps')
const BROWSER = previewFlagId('browser.ownChrome')

const flag = (id = STEPS, owner = '@test/plugin-onboarding'): PreviewFlagDeclaration => ({
  id, owner, kind: 'boolean', title: { en: 'Planned steps', zh: '计划中的步骤' }, description: { en: 'Shows the planned steps.', zh: '显示计划中的步骤。' },
})

/** A bundle directory holding one manifest. */
async function bundle(name: string, manifest: object | string): Promise<FlagBundle> {
  const dir = await mkdtemp(join(tmpdir(), 'delorun-preview-flags-'))
  onTestFinished(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify({ name, ...manifest }))
  return { name, dir }
}

const index = (rows: Readonly<Record<string, string>>): FlagIndex => ({
  owners: new Map(Object.entries(rows).map(([id, rowId]) => [previewFlagId(id), { bundle: '@test/bundle-studio', rowId }])),
  problems: [],
})

const ONE = index({ 'onboarding.previewSteps': 'delorun-onboarding' })
const rowsOn = (): boolean => false

describe('a flag id', () => {
  it('is dot-separated camel-case words', () => {
    expect(previewFlagId('onboarding.previewSteps')).toBe('onboarding.previewSteps')
    for (const bad of ['onboarding', 'Onboarding.steps', 'onboarding.preview-steps', 'onboarding..steps', '.steps', 'a b.c', '']) {
      expect(() => previewFlagId(bad), bad).toThrow('is not a preview flag id')
    }
  })
})

describe('the bundles\' index', () => {
  it('reads each row\'s flags from a bundle\'s manifest, and nothing from a manifest that lists none', async () => {
    const studio = await bundle('@test/bundle-studio', { delorun: { state: 'shipped', previewFlags: { 'delorun-onboarding': ['onboarding.previewSteps'], 'delorun-browser': ['browser.ownChrome'] } } })
    const plain = await bundle('@test/bundle-plain', { delorun: { state: 'shipped' } })
    const read = readFlagIndex([studio, plain])
    expect(read.problems).toEqual([])
    expect([...read.owners]).toEqual([
      [STEPS, { bundle: '@test/bundle-studio', rowId: 'delorun-onboarding' }],
      [BROWSER, { bundle: '@test/bundle-studio', rowId: 'delorun-browser' }],
    ])
  })

  it('reports a bundle whose list is malformed or unreadable and still reads the others', async () => {
    // Pins the per-bundle catch: without it one broken manifest hides every flag.
    const studio = await bundle('@test/bundle-studio', { delorun: { previewFlags: { 'delorun-onboarding': ['onboarding.previewSteps'] } } })
    const badId = await bundle('@test/bad-id', { delorun: { previewFlags: { row: ['Not An Id'] } } })
    const notJson = await bundle('@test/not-json', '{')
    const read = readFlagIndex([badId, notJson, studio])
    expect(read.problems.map(problem => problem.bundle)).toEqual(['@test/bad-id', '@test/not-json'])
    expect(read.problems[0]?.message).toContain('preview flag id')
    expect([...read.owners.keys()]).toEqual([STEPS])
  })

  it('reports a flag two rows list and keeps the first bundle\'s', async () => {
    // Pins the duplicate check: without it the later bundle silently takes the flag over.
    const first = await bundle('@test/first', { delorun: { previewFlags: { 'row-a': ['onboarding.previewSteps'] } } })
    const second = await bundle('@test/second', { delorun: { previewFlags: { 'row-b': ['browser.ownChrome', 'onboarding.previewSteps'] } } })
    const read = readFlagIndex([first, second])
    expect(read.problems).toEqual([{ bundle: '@test/second', message: '"previewFlags" lists onboarding.previewSteps for the row "row-b", which the row "row-a" of @test/first already lists' }])
    expect([...read.owners]).toEqual([[STEPS, { bundle: '@test/first', rowId: 'row-a' }]])
  })

  it('holds a plugin\'s declarations equal to its bundle\'s list', () => {
    const manifest = { delorun: { previewFlags: { 'delorun-onboarding': ['onboarding.previewSteps'] } } }
    expect(listedFlags(manifest)).toEqual({ 'delorun-onboarding': ['onboarding.previewSteps'] })
    expect(() => { assertFlagsIndexed(manifest, 'delorun-onboarding', [STEPS]) }).not.toThrow()
    expect(() => { assertFlagsIndexed(manifest, 'delorun-onboarding', [STEPS, BROWSER]) }).toThrow('browser.ownChrome is declared and not listed')
    expect(() => { assertFlagsIndexed(manifest, 'delorun-onboarding', []) }).toThrow('onboarding.previewSteps is listed and not declared')
    expect(() => { assertFlagsIndexed({}, 'delorun-onboarding', [STEPS]) }).toThrow('is declared and not listed')
  })
})

describe('the configured flags', () => {
  it('refuse a flag no bundle lists, naming it and the known flags', () => {
    // Pins the unknown-flag check: without it a mistyped flag is silently off.
    expect(() => createPreviewFlags({ configured: { 'onboarding.previwSteps': true }, index: ONE, rowOff: rowsOn }))
      .toThrow('delorun-preview-flags: "onboarding.previwSteps" is set, but no plugin of this profile declares it. Known flags: onboarding.previewSteps. Remove it with: delorun preview off <flag>')
    expect(() => createPreviewFlags({ configured: { 'a.b': false, 'c.d': true }, index: index({}), rowOff: rowsOn }))
      .toThrow('"a.b", "c.d" are set, but no plugin of this profile declares them. Known flags: none.')
  })

  it('refuse any flag where there is no profile to check it against', () => {
    // Pins the no-index check: without it a tree without a profile accepts every flag unchecked.
    expect(() => createPreviewFlags({ configured: { 'onboarding.previewSteps': true }, index: undefined, rowOff: rowsOn })).toThrow('there is no profile whose bundles could be read')
    expect(() => createPreviewFlags({ configured: {}, index: undefined, rowOff: rowsOn })).not.toThrow()
  })

  it('report a flag that is on while its declaring row is off, and leave one that is off unreported', () => {
    // Pins the notice: without it a flag whose plugin is off is skipped silently.
    const off = (rowId: string): boolean => rowId === 'delorun-onboarding'
    const { flags, notices } = createPreviewFlags({ configured: { 'onboarding.previewSteps': true }, index: ONE, rowOff: off })
    expect(notices).toEqual(['delorun-preview-flags: "onboarding.previewSteps" is on, but the row "delorun-onboarding" of @test/bundle-studio, whose plugin declares it, is off, so the flag changes nothing'])
    expect(flags.isOn(STEPS)).toBe(false)
    expect(createPreviewFlags({ configured: { 'onboarding.previewSteps': false }, index: ONE, rowOff: off }).notices).toEqual([])
    expect(createPreviewFlags({ configured: { 'onboarding.previewSteps': true }, index: ONE, rowOff: rowsOn }).notices).toEqual([])
  })
})

describe('the Host\'s flags', () => {
  it('are off by default and on only for a declared flag the row sets', () => {
    const unset = createPreviewFlags({ configured: {}, index: ONE, rowOff: rowsOn }).flags
    unset.declare(flag())
    expect(unset.isOn(STEPS)).toBe(false)
    const { flags } = createPreviewFlags({ configured: { 'onboarding.previewSteps': true }, index: ONE, rowOff: rowsOn })
    // Listed and set, but its plugin has not declared it: off.
    expect(flags.isOn(STEPS)).toBe(false)
    const withdraw = flags.declare(flag())
    expect(flags.isOn(STEPS)).toBe(true)
    withdraw()
    expect(flags.isOn(STEPS)).toBe(false)
    expect(flags.list()).toEqual([])
  })

  it('keep a later declaration when an earlier one is withdrawn again', () => {
    const { flags } = createPreviewFlags({ configured: {}, index: ONE, rowOff: rowsOn })
    const first = flags.declare(flag())
    first()
    flags.declare(flag())
    first()
    expect(flags.list().map(each => each.id)).toEqual(['onboarding.previewSteps'])
  })

  it('refuse to answer for an id that is neither declared nor listed, naming the known flags', () => {
    const { flags } = createPreviewFlags({ configured: {}, index: ONE, rowOff: rowsOn })
    expect(() => flags.isOn(BROWSER)).toThrow('delorun-preview-flags: "browser.ownChrome" is not a declared preview flag. Known flags: onboarding.previewSteps')
  })

  it('refuse a declaration the index does not list, and a second declaration of one flag', () => {
    // Pins the listing check: without it `delorun preview`, which reads only the index, would not know the flag.
    const { flags } = createPreviewFlags({ configured: {}, index: ONE, rowOff: rowsOn })
    expect(() => flags.declare(flag(BROWSER))).toThrow('@test/plugin-onboarding declares "browser.ownChrome", which no bundle of this profile lists under delorun.previewFlags in its package.json. Listed flags: onboarding.previewSteps')
    flags.declare(flag())
    expect(() => flags.declare(flag(STEPS, '@test/other'))).toThrow('@test/other declares "onboarding.previewSteps", which @test/plugin-onboarding already declared')
  })

  it('read the index again for a flag it does not list, so a bundle added while Delorun runs can declare its flags', () => {
    // Pins the re-read: without it a plugin pack added after the row loaded is refused until Delorun restarts.
    const reindex = vi.fn(() => index({ 'onboarding.previewSteps': 'delorun-onboarding', 'browser.ownChrome': 'delorun-browser' }))
    const { flags } = createPreviewFlags({ configured: {}, index: ONE, rowOff: rowsOn, reindex })
    flags.declare(flag())
    expect(reindex).not.toHaveBeenCalled()
    expect(flags.isOn(BROWSER)).toBe(false)
    flags.declare(flag(BROWSER, '@test/plugin-browser'))
    expect(reindex).toHaveBeenCalledTimes(1)
    // A flag the fresh index still does not list is refused, with the fresh list.
    const other = previewFlagId('other.flag')
    expect(() => flags.declare(flag(other))).toThrow('Listed flags: browser.ownChrome, onboarding.previewSteps')
    expect(() => flags.isOn(other)).toThrow('is not a declared preview flag')
  })

  it('take any declaration in a tree without a profile, where no index exists', () => {
    const { flags } = createPreviewFlags({ configured: {}, index: undefined, rowOff: rowsOn })
    flags.declare(flag(BROWSER))
    expect(flags.isOn(BROWSER)).toBe(false)
  })

  it('list the declared flags by id with their state', () => {
    const { flags } = createPreviewFlags({ configured: { 'onboarding.previewSteps': true }, index: index({ 'onboarding.previewSteps': 'delorun-onboarding', 'browser.ownChrome': 'delorun-browser' }), rowOff: rowsOn })
    flags.declare(flag())
    flags.declare(flag(BROWSER, '@test/plugin-browser'))
    expect(flags.list().map(each => [each.id, each.owner, each.on])).toEqual([['browser.ownChrome', '@test/plugin-browser', false], ['onboarding.previewSteps', '@test/plugin-onboarding', true]])
    expect(flags.list()[1]).toEqual({ id: 'onboarding.previewSteps', kind: 'boolean', owner: '@test/plugin-onboarding', title: { en: 'Planned steps', zh: '计划中的步骤' }, description: { en: 'Shows the planned steps.', zh: '显示计划中的步骤。' }, on: true })
  })
})
