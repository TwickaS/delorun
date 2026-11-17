/**
 * `delorun preview` over a real profile directory: the flags come from the bundles' manifests and the composed rows,
 * `on` and `off` write the profile's own patch and read back through `list`, and an unknown flag is refused with the
 * known ones. Each test's comment names the check whose removal makes it fail.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Config, PREVIEW_FLAGS_ROW_ID } from '@delorun/preview-flags'
import { CliError, EXIT } from '../../src/exit.ts'
import { createPreviewCommand, listPreviewFlags, PREVIEW_FLAGS_ROW, PREVIEW_USAGE, setPreviewFlag, type PreviewRequest } from '../../src/preview/command.ts'

let home: string
let profileDir: string
let patchPath: string

/** Write the studio bundle the profile lists: its manifest's flag index and its patch. */
function writeBundle(options: { readonly onboardingOff?: boolean, readonly flags?: object, readonly row?: boolean } = {}): void {
  const dir = join(profileDir, 'node_modules', '@test', 'bundle-studio')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@test/bundle-studio', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
    delorun: { previewFlags: options.flags ?? { 'delorun-onboarding': ['onboarding.previewSteps'], 'delorun-browser': ['browser.ownChrome'] } },
  }))
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: delorun-onboarding',
    '      name: \'@test/plugin-onboarding\'',
    ...options.onboardingOff === true ? ['      disabled: true'] : [],
    '    - id: delorun-browser',
    '      name: \'@test/plugin-browser\'',
    ...options.row === false ? [] : [`    - id: ${PREVIEW_FLAGS_ROW}`, '      name: \'@delorun/preview-flags\''],
    '',
  ].join('\n'))
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-preview-')))
  profileDir = join(home, 'profiles', 'default')
  patchPath = join(profileDir, 'cordis.patch.yml')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'profile', private: true, dsh: { profile: { bundles: ['@test/bundle-studio'] } } })}\n`)
  writeBundle()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** One run's request, with what it printed. */
function request(running = false): { readonly request: PreviewRequest, readonly out: string[], readonly err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, request: { home, profile: 'default', profileDir, installAnchor: join(home, 'no-installation', 'package.json'), running, output: { stdout: (text) => { out.push(text) }, stderr: (text) => { err.push(text) } } } }
}

/** The `flags` the profile's own patch holds for the row. */
function written(): unknown {
  const rows = parse(readFileSync(patchPath, 'utf8')) as { id?: string, config?: { flags?: unknown } }[]
  return rows.find(row => row.id === PREVIEW_FLAGS_ROW)?.config?.flags
}

describe('delorun preview', () => {
  it('names the row as the package does', () => {
    expect(PREVIEW_FLAGS_ROW).toBe(PREVIEW_FLAGS_ROW_ID)
  })

  it('lists each flag off with its plugin before anything is set', () => {
    const { request: run, out, err } = request()
    expect(listPreviewFlags(run)).toBe(EXIT.ok)
    expect(out.join('')).toBe([
      'Preview flags of the profile default:',
      '  browser.ownChrome        off  @test/plugin-browser',
      '  onboarding.previewSteps  off  @test/plugin-onboarding',
      '',
      'Turn one on with: delorun preview on <flag>',
      '',
    ].join('\n'))
    expect(err).toEqual([])
    expect(existsSync(patchPath)).toBe(false)
  })

  it('turns a flag on in the profile\'s own patch, reads it back, and turns it off again', async () => {
    const on = request()
    expect(await setPreviewFlag(on.request, 'onboarding.previewSteps', true)).toBe(EXIT.ok)
    expect(on.out.join('')).toBe('onboarding.previewSteps is on for the profile default. It applies from the next start.\n')
    expect(written()).toEqual({ 'onboarding.previewSteps': true })
    // What was written is a configuration the row's schema takes.
    expect(Config({ flags: written() as Record<string, boolean> })).toEqual({ flags: { 'onboarding.previewSteps': true } })
    const listed = request()
    listPreviewFlags(listed.request)
    expect(listed.out.join('')).toContain('  onboarding.previewSteps  on   @test/plugin-onboarding\n')
    expect(listed.out.join('')).toContain('  browser.ownChrome        off  @test/plugin-browser\n')

    await setPreviewFlag(request().request, 'browser.ownChrome', true)
    expect(written()).toEqual({ 'onboarding.previewSteps': true, 'browser.ownChrome': true })

    const off = request(true)
    expect(await setPreviewFlag(off.request, 'onboarding.previewSteps', false)).toBe(EXIT.ok)
    expect(off.out.join('')).toBe('onboarding.previewSteps is off for the profile default. Delorun is running: stop and start it to apply the change.\n')
    expect(written()).toEqual({ 'browser.ownChrome': true })
    expect(existsSync(`${join(profileDir, 'package.json')}.lock`)).toBe(false)
  })

  it('keeps the other rows of the profile\'s patch', async () => {
    writeFileSync(patchPath, '- id: studio\n  config:\n    port: 4100\n')
    await setPreviewFlag(request().request, 'onboarding.previewSteps', true)
    expect(parse(readFileSync(patchPath, 'utf8'))).toEqual([{ id: 'studio', config: { port: 4100 } }, { id: PREVIEW_FLAGS_ROW, config: { flags: { 'onboarding.previewSteps': true } } }])
  })

  it('refuses to turn on a flag the profile does not know, naming the known flags, and writes nothing', async () => {
    // Pins the unknown-flag check: without it a mistyped flag is written and the row refuses to load at the next start.
    const failure = await setPreviewFlag(request().request, 'onboarding.previwSteps', true).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CliError)
    expect((failure as CliError).exit).toBe(EXIT.usage)
    expect((failure as CliError).message).toBe('delorun preview on: "onboarding.previwSteps" is not a preview flag of the profile default. Did you mean onboarding.previewSteps? Known flags: browser.ownChrome, onboarding.previewSteps')
    expect(existsSync(patchPath)).toBe(false)
    await expect(setPreviewFlag(request().request, 'nothing.likeIt', false)).rejects.toThrow('"nothing.likeIt" is not a preview flag of the profile default.')
  })

  it('lists a set flag that is no longer known and lets off remove it', async () => {
    // Pins off's exception: without it the only way out of a row that refuses to load is editing the patch by hand.
    writeFileSync(patchPath, `- id: ${PREVIEW_FLAGS_ROW}\n  config:\n    flags:\n      retired.flag: true\n      onboarding.previewSteps: true\n`)
    const listed = request()
    listPreviewFlags(listed.request)
    expect(listed.out.join('')).toContain('  retired.flag             not a flag of this profile; Delorun\'s preview flags do not load with it. Remove it with: delorun preview off retired.flag\n')
    const off = request()
    await setPreviewFlag(off.request, 'retired.flag', false)
    expect(off.out.join('')).toBe('retired.flag is off for the profile default. It applies from the next start.\n')
    expect(written()).toEqual({ 'onboarding.previewSteps': true })
  })

  it('reports a flag whose plugin is off, in the list and when it is turned on', async () => {
    // Pins the owner-off report: without it the flag is on and silently changes nothing.
    writeBundle({ onboardingOff: true })
    const on = request()
    await setPreviewFlag(on.request, 'onboarding.previewSteps', true)
    expect(on.err.join('')).toBe('delorun: warning: @test/plugin-onboarding, which declares onboarding.previewSteps, is off in this profile, so the flag changes nothing until it is on.\n')
    const listed = request()
    listPreviewFlags(listed.request)
    expect(listed.out.join('')).toContain('  onboarding.previewSteps  on   @test/plugin-onboarding  (its plugin is off, so the flag changes nothing)\n')
  })

  it('says that another patch still sets a flag after off', async () => {
    writeFileSync(join(home, 'cordis.patch.yml'), `- id: ${PREVIEW_FLAGS_ROW}\n  config:\n    flags:\n      onboarding.previewSteps: true\n`)
    const off = request()
    await setPreviewFlag(off.request, 'onboarding.previewSteps', false)
    expect(off.out).toEqual([])
    expect(off.err.join('')).toContain('onboarding.previewSteps is still on for the profile default: a patch other than')
  })

  it('warns about a bundle whose flag list is malformed and still lists the others', () => {
    writeBundle({ flags: { 'delorun-onboarding': ['Not An Id'] } })
    const listed = request()
    listPreviewFlags(listed.request)
    expect(listed.err.join('')).toContain('delorun: warning: the preview flags of @test/bundle-studio were not read:')
    expect(listed.out.join('')).toBe('No plugin of the profile default declares a preview flag.\n')
  })

  it('fails for a directory without a profile, and for a profile without the row', async () => {
    writeBundle({ row: false })
    await expect(setPreviewFlag(request().request, 'onboarding.previewSteps', true)).rejects.toThrow('the profile default has no delorun-preview-flags row, which holds the flags; it does not load Delorun\'s studio bundle')
    rmSync(join(profileDir, 'package.json'))
    expect(() => listPreviewFlags(request().request)).toThrow('holds no profile; run delorun setup first')
  })

  it('refuses a wrong command line with the usage, before any home is touched', async () => {
    const command = createPreviewCommand({ installAnchor: () => Promise.reject(new Error('not reached')), running: () => false })
    const context = { env: { DELORUN_HOME: join(home, 'untouched') }, stdout: () => undefined, stderr: () => undefined }
    for (const [args, problem] of [[[], 'name an action'], [['enable', 'x.y'], '"enable" is not an action'], [['on'], 'name one flag'], [['on', 'a.b', 'c.d'], 'name one flag'], [['list', 'a.b'], 'list takes no flag']] as const) {
      const failure = await command.run(args, context).catch((error: unknown) => error)
      expect((failure as CliError).exit, problem).toBe(EXIT.usage)
      expect((failure as CliError).message, problem).toBe(`delorun preview: ${problem}\n${PREVIEW_USAGE}`)
    }
    expect(existsSync(join(home, 'untouched'))).toBe(false)
  })
})
