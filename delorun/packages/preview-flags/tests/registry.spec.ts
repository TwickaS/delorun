/**
 * The packages' flag index and the Host's flags: what the row refuses when it loads, what a declaration is checked
 * against, and what `isOn` answers. Each test's comment names the check whose removal makes it fail.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { previewFlagId, type PreviewFlagDeclaration } from '../src/flags.ts'
import { assertFlagsIndexed, listedFlags, packageOf, readFlagIndex, resolvePackageDir, rowPackages, type FlagIndex, type FlagPackage } from '../src/manifest.ts'
import { createPreviewFlags } from '../src/registry.ts'

const STEPS = previewFlagId('onboarding.previewSteps')
const BROWSER = previewFlagId('browser.ownChrome')

const flag = (id = STEPS, owner = '@test/plugin-onboarding'): PreviewFlagDeclaration => ({
  id, owner, kind: 'boolean', title: { en: 'Planned steps', zh: '计划中的步骤' }, description: { en: 'Shows the planned steps.', zh: '显示计划中的步骤。' },
})

/** A package directory holding one manifest. */
async function pkg(name: string, manifest: object | string): Promise<FlagPackage> {
  const dir = await mkdtemp(join(tmpdir(), 'delorun-preview-flags-'))
  onTestFinished(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify({ name, ...manifest }))
  return { name, dir }
}

const index = (owners: Readonly<Record<string, string>>): FlagIndex => ({
  owners: new Map(Object.entries(owners).map(([id, owner]) => [previewFlagId(id), owner])),
  problems: [],
})

const ONE = index({ 'onboarding.previewSteps': '@test/plugin-onboarding' })
const BOTH = index({ 'onboarding.previewSteps': '@test/plugin-onboarding', 'browser.ownChrome': '@test/plugin-browser' })
const pluginsOn = (): boolean => false

describe('a flag id', () => {
  it('is dot-separated camel-case words', () => {
    expect(previewFlagId('onboarding.previewSteps')).toBe('onboarding.previewSteps')
    for (const bad of ['onboarding', 'Onboarding.steps', 'onboarding.preview-steps', 'onboarding..steps', '.steps', 'a b.c', '']) {
      expect(() => previewFlagId(bad), bad).toThrow('is not a preview flag id')
    }
  })
})

describe('the packages\' index', () => {
  it('reads the flags a package lists in its manifest, and nothing from a manifest that lists none', async () => {
    const onboarding = await pkg('@test/plugin-onboarding', { delorun: { state: 'shipped', previewFlags: ['onboarding.previewSteps'] } })
    const browser = await pkg('@test/plugin-browser', { delorun: { previewFlags: ['browser.ownChrome'] } })
    const plain = await pkg('@test/plain', { delorun: { state: 'shipped' } })
    const read = readFlagIndex([onboarding, plain, browser])
    expect(read.problems).toEqual([])
    expect([...read.owners]).toEqual([[STEPS, '@test/plugin-onboarding'], [BROWSER, '@test/plugin-browser']])
  })

  it('reports a package whose list is malformed or unreadable and still reads the others', async () => {
    // Pins the per-package catch: without it one broken manifest hides every flag.
    const onboarding = await pkg('@test/plugin-onboarding', { delorun: { previewFlags: ['onboarding.previewSteps'] } })
    const badId = await pkg('@test/bad-id', { delorun: { previewFlags: ['Not An Id'] } })
    const keyed = await pkg('@test/keyed', { delorun: { previewFlags: { row: ['a.b'] } } })
    const notJson = await pkg('@test/not-json', '{')
    const read = readFlagIndex([badId, keyed, notJson, onboarding])
    expect(read.problems.map(problem => problem.package)).toEqual(['@test/bad-id', '@test/keyed', '@test/not-json'])
    expect(read.problems[0]?.message).toContain('preview flag id')
    expect([...read.owners.keys()]).toEqual([STEPS])
  })

  it('reports a flag two packages list and keeps the first package\'s', async () => {
    // Pins the duplicate check: without it the later package silently takes the flag over.
    const first = await pkg('@test/first', { delorun: { previewFlags: ['onboarding.previewSteps'] } })
    const second = await pkg('@test/second', { delorun: { previewFlags: ['browser.ownChrome', 'onboarding.previewSteps'] } })
    const read = readFlagIndex([first, second])
    expect(read.problems).toEqual([{ package: '@test/second', message: '"previewFlags" lists onboarding.previewSteps, which @test/first already lists' }])
    expect([...read.owners]).toEqual([[STEPS, '@test/first']])
  })

  it('names the package a row loads from, and none for a path', () => {
    expect(['@delorun/plugin-onboarding', '@delorun/bundle-local/trust', 'plain', 'plain/sub/module', './local.ts', '/abs/plugin.js', '', undefined, 7].map(packageOf))
      .toEqual(['@delorun/plugin-onboarding', '@delorun/bundle-local', 'plain', 'plain', undefined, undefined, undefined, undefined, undefined])
  })

  it('finds each row\'s package once, from the first anchor that reaches it, and leaves out one no anchor reaches', async () => {
    const bundle = await pkg('@test/bundle-studio', {})
    await mkdir(join(bundle.dir, 'node_modules', '@test', 'plugin-onboarding'), { recursive: true })
    await writeFile(join(bundle.dir, 'node_modules', '@test', 'plugin-onboarding', 'package.json'), JSON.stringify({ name: '@test/plugin-onboarding', delorun: { previewFlags: ['onboarding.previewSteps'] } }))
    const elsewhere = await pkg('elsewhere', {})
    const anchors = [join(elsewhere.dir, 'package.json'), join(bundle.dir, 'package.json')]
    expect(resolvePackageDir('@test/plugin-onboarding', [anchors[0] as string])).toBeUndefined()
    const packages = rowPackages(['@test/plugin-onboarding', '@test/plugin-onboarding/client', '@test/not-installed', './local.ts', undefined], anchors)
    expect(packages.map(each => each.name)).toEqual(['@test/plugin-onboarding'])
    expect([...readFlagIndex(packages).owners]).toEqual([[STEPS, '@test/plugin-onboarding']])
  })

  it('holds a plugin\'s declarations equal to its package\'s list', () => {
    const manifest = { delorun: { previewFlags: ['onboarding.previewSteps'] } }
    expect(listedFlags(manifest)).toEqual(['onboarding.previewSteps'])
    expect(() => { assertFlagsIndexed(manifest, [STEPS]) }).not.toThrow()
    expect(() => { assertFlagsIndexed(manifest, [STEPS, BROWSER]) }).toThrow('browser.ownChrome is declared and not listed')
    expect(() => { assertFlagsIndexed(manifest, []) }).toThrow('onboarding.previewSteps is listed and not declared')
    expect(() => { assertFlagsIndexed({}, [STEPS]) }).toThrow('is declared and not listed')
  })
})

describe('the configured flags', () => {
  it('refuse a flag no package lists, naming it and the known flags', () => {
    // Pins the unknown-flag check: without it a mistyped flag is silently off.
    expect(() => createPreviewFlags({ configured: { 'onboarding.previwSteps': true }, index: ONE, pluginOff: pluginsOn }))
      .toThrow('delorun-preview-flags: "onboarding.previwSteps" is set, but no plugin of this profile declares it. Known flags: onboarding.previewSteps. Remove it with: delorun preview off <flag>')
    expect(() => createPreviewFlags({ configured: { 'a.b': false, 'c.d': true }, index: index({}), pluginOff: pluginsOn }))
      .toThrow('"a.b", "c.d" are set, but no plugin of this profile declares them. Known flags: none.')
  })

  it('refuse any flag where there is no profile to check it against', () => {
    // Pins the no-index check: without it a tree without a profile accepts every flag unchecked.
    expect(() => createPreviewFlags({ configured: { 'onboarding.previewSteps': true }, index: undefined, pluginOff: pluginsOn })).toThrow('there is no profile whose plugins could be read')
    expect(() => createPreviewFlags({ configured: {}, index: undefined, pluginOff: pluginsOn })).not.toThrow()
  })

  it('report a flag that is on while its declaring plugin is off, and leave one that is off unreported', () => {
    // Pins the notice: without it a flag whose plugin is off is skipped silently.
    const off = (owner: string): boolean => owner === '@test/plugin-onboarding'
    const { flags, notices } = createPreviewFlags({ configured: { 'onboarding.previewSteps': true }, index: ONE, pluginOff: off })
    expect(notices).toEqual(['delorun-preview-flags: "onboarding.previewSteps" is on, but @test/plugin-onboarding, which declares it, is off in this profile, so the flag changes nothing'])
    expect(flags.isOn(STEPS)).toBe(false)
    expect(createPreviewFlags({ configured: { 'onboarding.previewSteps': false }, index: ONE, pluginOff: off }).notices).toEqual([])
    expect(createPreviewFlags({ configured: { 'onboarding.previewSteps': true }, index: ONE, pluginOff: pluginsOn }).notices).toEqual([])
  })
})

describe('a retired flag', () => {
  // Removing the retired-id filter makes a home that once set `unlock.passkeys` fail to load, which turns every other flag off.
  it('is ignored with one notice while the other flags keep their state, and an unknown id still throws', () => {
    const created = createPreviewFlags({ configured: { 'unlock.passkeys': true, 'onboarding.previewSteps': true }, index: ONE, pluginOff: pluginsOn })
    expect(created.notices).toHaveLength(1)
    expect(created.notices[0]).toContain('"unlock.passkeys" is retired and ignored')
    created.flags.declare(flag())
    expect(created.flags.isOn(STEPS)).toBe(true)
    expect(createPreviewFlags({ configured: { 'unlock.passkeys': false }, index: undefined, pluginOff: pluginsOn }).notices).toHaveLength(1)
    expect(() => createPreviewFlags({ configured: { 'unlock.passkeys': true, 'unlock.nothing': true }, index: ONE, pluginOff: pluginsOn })).toThrow('"unlock.nothing" is set')
  })
})

describe('the Host\'s flags', () => {
  it('are off by default and on only for a declared flag the row sets', () => {
    const unset = createPreviewFlags({ configured: {}, index: ONE, pluginOff: pluginsOn }).flags
    unset.declare(flag())
    expect(unset.isOn(STEPS)).toBe(false)
    const { flags } = createPreviewFlags({ configured: { 'onboarding.previewSteps': true }, index: ONE, pluginOff: pluginsOn })
    // Listed and set, but its plugin has not declared it: off.
    expect(flags.isOn(STEPS)).toBe(false)
    const withdraw = flags.declare(flag())
    expect(flags.isOn(STEPS)).toBe(true)
    withdraw()
    expect(flags.isOn(STEPS)).toBe(false)
    expect(flags.list()).toEqual([])
  })

  it('keep a later declaration when an earlier one is withdrawn again', () => {
    const { flags } = createPreviewFlags({ configured: {}, index: ONE, pluginOff: pluginsOn })
    const first = flags.declare(flag())
    first()
    flags.declare(flag())
    first()
    expect(flags.list().map(each => each.id)).toEqual(['onboarding.previewSteps'])
  })

  it('refuse to answer for an id that is neither declared nor listed, naming the known flags', () => {
    const { flags } = createPreviewFlags({ configured: {}, index: ONE, pluginOff: pluginsOn })
    expect(() => flags.isOn(BROWSER)).toThrow('delorun-preview-flags: "browser.ownChrome" is not a declared preview flag. Known flags: onboarding.previewSteps')
  })

  it('refuse a declaration the index does not list, and a second declaration of one flag', () => {
    // Pins the listing check: without it `delorun preview`, which reads only the index, would not know the flag.
    const { flags } = createPreviewFlags({ configured: {}, index: ONE, pluginOff: pluginsOn })
    expect(() => flags.declare(flag(BROWSER))).toThrow('@test/plugin-onboarding declares "browser.ownChrome", which no package of this profile lists under delorun.previewFlags in its package.json. Listed flags: onboarding.previewSteps')
    // A flag another package lists is not this plugin's to declare.
    expect(() => createPreviewFlags({ configured: {}, index: BOTH, pluginOff: pluginsOn }).flags.declare(flag(BROWSER))).toThrow('@test/plugin-onboarding declares "browser.ownChrome", which @test/plugin-browser lists as its own')
    flags.declare(flag())
    expect(() => flags.declare(flag())).toThrow('@test/plugin-onboarding declares "onboarding.previewSteps", which @test/plugin-onboarding already declared')
  })

  it('read the index again for a flag it does not list, so a bundle added while Delorun runs can declare its flags', () => {
    // Pins the re-read: without it a plugin added after the row loaded, as a plugin pack brings one, is refused until Delorun restarts.
    const reindex = vi.fn(() => BOTH)
    const { flags } = createPreviewFlags({ configured: {}, index: ONE, pluginOff: pluginsOn, reindex })
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
    const { flags } = createPreviewFlags({ configured: {}, index: undefined, pluginOff: pluginsOn })
    flags.declare(flag(BROWSER))
    expect(flags.isOn(BROWSER)).toBe(false)
  })

  it('list the declared flags by id with their state', () => {
    const { flags } = createPreviewFlags({ configured: { 'onboarding.previewSteps': true }, index: BOTH, pluginOff: pluginsOn })
    flags.declare(flag())
    flags.declare(flag(BROWSER, '@test/plugin-browser'))
    expect(flags.list().map(each => [each.id, each.owner, each.on])).toEqual([['browser.ownChrome', '@test/plugin-browser', false], ['onboarding.previewSteps', '@test/plugin-onboarding', true]])
    expect(flags.list()[1]).toEqual({ id: 'onboarding.previewSteps', kind: 'boolean', owner: '@test/plugin-onboarding', title: { en: 'Planned steps', zh: '计划中的步骤' }, description: { en: 'Shows the planned steps.', zh: '显示计划中的步骤。' }, on: true })
  })
})
