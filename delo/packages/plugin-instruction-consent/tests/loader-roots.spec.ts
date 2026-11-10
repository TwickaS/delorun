/**
 * The consent's roots against the loaders' reads: for a fixture configuration, every file the workspace instruction
 * loader discovers, every skill the filesystem skill provider lists, and every composition file the profile launcher
 * reads is a file whose write the consent asks about. A loader that starts reading a location the consent does not
 * classify fails here.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { discoverBaselineInstructionFiles } from '@deepseek-ai/dsh-agent-instructions'
import { readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { INSTRUCTION_FILE_NAMES } from '../src/classify.ts'
import { compositionFiles, InstructionConsent } from '../src/index.ts'

/** Every path the profile launcher passes to `readFileSync` while the trace is on. */
const trace = vi.hoisted(() => ({ on: false, paths: [] as string[] }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const readFileSync: typeof actual.readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    if (trace.on && typeof args[0] === 'string') trace.paths.push(args[0])
    return actual.readFileSync(...args)
  }) as typeof actual.readFileSync
  return { ...actual, readFileSync, default: { ...actual, readFileSync } }
})

let root: string
let saved: { home: string | undefined; agents: string | undefined }

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'delo-consent-roots-')))
  saved = { home: process.env['DSH_HOME'], agents: process.env['DSH_AGENTS_HOME'] }
  process.env['DSH_HOME'] = join(root, 'home', '.delo')
  process.env['DSH_AGENTS_HOME'] = join(root, 'home', '.agents')
})

afterEach(() => {
  restore('DSH_HOME', saved.home)
  restore('DSH_AGENTS_HOME', saved.agents)
  trace.on = false
  trace.paths.length = 0
  rmSync(root, { recursive: true, force: true })
})

/**
 * Restore one environment variable.
 * @param key - the variable.
 * @param value - its saved value, undefined when it was unset.
 */
function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

/**
 * Write one file, creating its directories.
 * @param path - the file.
 * @param content - its content.
 */
function put(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

/**
 * Write one skill.
 * @param directory - the skill root.
 * @param name - the skill name.
 */
function skill(directory: string, name: string): void {
  put(join(directory, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n\nUse ${name}.\n`)
}

/**
 * Whether a consent asks before a write to one path.
 * @param consent - the consent, mounted on a context with whatever loader services the case provides.
 * @param path - the target path.
 * @returns whether the review requires consent.
 */
function asks(consent: InstructionConsent, path: string): boolean {
  return consent.review({ tool: 'write', path })?.required === true
}

describe('the workspace instruction loader', () => {
  it('reads no instruction file whose write the consent does not ask about', async () => {
    const project = join(root, 'work')
    mkdirSync(join(project, '.git'), { recursive: true })
    for (const name of INSTRUCTION_FILE_NAMES) {
      put(join(root, 'home', '.delo', name), name)
      put(join(root, 'home', '.agents', name), name)
      put(join(project, name), name)
      put(join(project, 'app', name), name)
    }
    symlinkSync(join(project, 'app'), join(root, 'linked-app'))
    // Each home's instruction file links out of the home, so the loader reads a file outside every home.
    for (const home of ['.delo', '.agents']) {
      put(join(root, 'shared', home, 'rules.md'), 'shared rules')
      rmSync(join(root, 'home', home, 'AGENTS.md'))
      symlinkSync(join(root, 'shared', home, 'rules.md'), join(root, 'home', home, 'AGENTS.md'))
    }
    const discovered = [
      ...await discoverBaselineInstructionFiles({ cwd: join(project, 'app') }),
      ...await discoverBaselineInstructionFiles({ cwd: join(root, 'linked-app') }),
    ]
    expect(discovered.length).toBeGreaterThan(INSTRUCTION_FILE_NAMES.length)
    const consent = new InstructionConsent(new Context())
    for (const file of discovered) {
      expect(asks(consent, file.absolutePath), file.absolutePath).toBe(true)
      expect(asks(consent, realpathSync(file.absolutePath)), file.absolutePath).toBe(true)
    }
  })
})

describe('the filesystem skill provider', () => {
  it('lists no skill whose write the consent does not ask about', async () => {
    const project = join(root, 'work')
    mkdirSync(join(project, '.git'), { recursive: true })
    skill(join(root, 'home', '.delo', 'skills'), 'home-skill')
    skill(join(root, 'home', '.agents', 'skills'), 'shared-skill')
    skill(join(project, '.dsh', 'skills'), 'project-dsh-skill')
    skill(join(project, '.agents', 'skills'), 'project-agents-skill')
    skill(join(root, 'company'), 'custom-skill')
    skill(join(root, 'bundled'), 'bundled-skill')
    mkdirSync(join(root, 'linked'))
    symlinkSync(join(root, 'company'), join(root, 'linked', 'skills'))
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillFileSystem, {
        dshHome: join(root, 'home', '.delo'),
        agentsHome: join(root, 'home', '.agents'),
        customSkillDirs: [join(root, 'linked', 'skills')],
        bundledSkillDir: join(root, 'bundled'),
        watch: false,
      })
      const consent = new InstructionConsent(ctx)
      const listed = await ctx.skills.list({ cwd: project })
      expect(listed.map(entry => entry.name).sort()).toEqual([
        'bundled-skill', 'custom-skill', 'home-skill', 'project-agents-skill', 'project-dsh-skill', 'shared-skill',
      ])
      for (const entry of listed) {
        expect(entry.path, entry.name).toBeDefined()
        expect(asks(consent, entry.path ?? ''), entry.name).toBe(true)
      }
      // The real directory behind the linked custom root is the directory the provider reads.
      expect(asks(consent, join(root, 'company', 'custom-skill', 'SKILL.md'))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the profile launcher', () => {
  it('reads no composition file whose write the consent does not ask about', () => {
    const home = join(root, 'home', '.delo')
    const dir = join(home, 'profiles', 'default')
    put(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['fixture-bundle'] } } }))
    put(join(dir, 'node_modules', 'fixture-bundle', 'package.json'), JSON.stringify({
      name: 'fixture-bundle', dsh: { bundle: { patch: ['./cordis.patch.yml', './presets/reviewer.patch.yml'] } },
    }))
    put(join(dir, 'node_modules', 'fixture-bundle', 'cordis.patch.yml'), '[]\n')
    put(join(dir, 'node_modules', 'fixture-bundle', 'presets', 'reviewer.patch.yml'), '[]\n')
    put(join(dir, 'cordis.patch.yml'), '[]\n')
    put(join(home, 'cordis.patch.yml'), '[]\n')
    const context: ProfileContext = {
      name: 'default', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(dir, 'package.json'),
      cwd: root, home, startedBundles: ['fixture-bundle'], overlays: [], telemetryDisabledEnv: undefined,
    }
    trace.on = true
    readProfilePatches('delo', context)
    trace.on = false
    const read = [...new Set(trace.paths.filter(path => /\.ya?ml$/u.test(path)))]
    expect(read).toHaveLength(4)
    const ctx = new Context()
    ctx.provide('profileContext', context)
    const consent = new InstructionConsent(ctx)
    for (const path of read) expect(asks(consent, path), path).toBe(true)
    expect(compositionFiles(context).map(file => file.layer)).toEqual(['bundle', 'bundle', 'profile', 'home'])
  })
})
