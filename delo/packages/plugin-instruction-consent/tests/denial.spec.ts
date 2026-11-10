/**
 * Denial specs of `@delo/plugin-instruction-consent`'s path classification: a write that reaches an instruction-layer
 * file through a symbolic link, a hard link, a different letter case on a case-insensitive volume, a link at the
 * instruction root itself, or a home the loader resolved before the environment changed asks for consent, and the same
 * spelling on a case-sensitive volume asks nothing.
 */
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { classifyTarget, probeCaseInsensitive } from '../src/classify.ts'
import { InstructionConsent } from '../src/index.ts'

let root: string
let env: { DSH_HOME: string; DSH_AGENTS_HOME: string }

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'delo-instruction-consent-')))
  env = { DSH_HOME: join(root, 'home', '.delo'), DSH_AGENTS_HOME: join(root, 'home', '.agents') }
  mkdirSync(join(env.DSH_HOME, 'skills', 'review'), { recursive: true })
  writeFileSync(join(env.DSH_HOME, 'skills', 'review', 'SKILL.md'), 'skill')
  writeFileSync(join(env.DSH_HOME, 'AGENTS.md'), 'rules')
  mkdirSync(join(root, 'work', 'src'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A probe that reports every volume case-sensitive. */
const sensitive = (): boolean => false
/** A probe that reports every volume case-insensitive, the answer a default macOS or Windows volume gives. */
const insensitive = (): boolean => true

describe('a write through a symbolic link', () => {
  it('a write through a symlinked directory into the home skill store asks for consent', () => {
    symlinkSync(join(env.DSH_HOME, 'skills'), join(root, 'work', 'tools'))
    const options = { env, caseInsensitive: sensitive }
    expect(classifyTarget(join(root, 'work', 'tools', 'review', 'SKILL.md'), options)).toEqual({ kind: 'skill', root: 'home' })
    expect(classifyTarget(join(root, 'work', 'tools', 'new-skill', 'SKILL.md'), options)).toEqual({ kind: 'skill', root: 'home' })
  })

  it('a write through a symlinked file to the home AGENTS.md asks for consent', () => {
    symlinkSync(join(env.DSH_HOME, 'AGENTS.md'), join(root, 'work', 'notes.md'))
    expect(classifyTarget(join(root, 'work', 'notes.md'), { env, caseInsensitive: sensitive }))
      .toEqual({ kind: 'instructions', scope: 'global' })
  })

  it('a write into the directory a symlinked configured skill root points at asks for consent', () => {
    mkdirSync(join(root, 'data', 'skills'), { recursive: true })
    symlinkSync(join(root, 'data', 'skills'), join(root, 'company-skills'))
    expect(classifyTarget(join(root, 'data', 'skills', 'lint', 'SKILL.md'), {
      env, skillRoots: [join(root, 'company-skills')], caseInsensitive: sensitive,
    })).toEqual({ kind: 'skill', root: 'custom' })
  })

  it('a write into the home a symlinked DSH_HOME points at asks for consent', () => {
    symlinkSync(env.DSH_HOME, join(root, 'linked-home'))
    const linked = { ...env, DSH_HOME: join(root, 'linked-home') }
    expect(classifyTarget(join(env.DSH_HOME, 'skills', 'review', 'SKILL.md'), { env: linked, caseInsensitive: sensitive }))
      .toEqual({ kind: 'skill', root: 'home' })
    expect(classifyTarget(join(env.DSH_HOME, 'AGENTS.md'), { env: linked, caseInsensitive: sensitive }))
      .toEqual({ kind: 'instructions', scope: 'global' })
  })

  it('a write to the file a home AGENTS.md links to asks for consent', () => {
    writeFileSync(join(root, 'work', 'shared-rules.md'), 'rules')
    rmSync(join(env.DSH_AGENTS_HOME), { recursive: true, force: true })
    mkdirSync(env.DSH_AGENTS_HOME, { recursive: true })
    symlinkSync(join(root, 'work', 'shared-rules.md'), join(env.DSH_AGENTS_HOME, 'AGENTS.md'))
    expect(classifyTarget(join(root, 'work', 'shared-rules.md'), { env, caseInsensitive: sensitive }))
      .toEqual({ kind: 'instructions', scope: 'global' })
  })

  it('a write to an AGENTS.md that links to an ordinary file asks for consent', () => {
    writeFileSync(join(root, 'work', 'src', 'notes.md'), 'notes')
    symlinkSync(join(root, 'work', 'src', 'notes.md'), join(root, 'work', 'AGENTS.md'))
    expect(classifyTarget(join(root, 'work', 'AGENTS.md'), { env, caseInsensitive: sensitive }))
      .toEqual({ kind: 'instructions', scope: 'folder' })
  })

  it('a write to an ordinary file through an ordinary directory asks nothing', () => {
    symlinkSync(join(root, 'work', 'src'), join(root, 'work', 'lib'))
    expect(classifyTarget(join(root, 'work', 'lib', 'index.ts'), { env, caseInsensitive: sensitive })).toBeUndefined()
  })
})

describe('a write spelled in a different letter case', () => {
  it('a case variant of AGENTS.md on a case-insensitive volume asks for consent', () => {
    expect(classifyTarget(join(root, 'work', 'agents.md'), { env, caseInsensitive: insensitive }))
      .toEqual({ kind: 'instructions', scope: 'folder' })
    expect(classifyTarget(join(root, 'work', 'src', 'Claude.Local.MD'), { env, caseInsensitive: insensitive }))
      .toEqual({ kind: 'instructions', scope: 'folder' })
  })

  it('a case variant of a home skill store path on a case-insensitive volume asks for consent', () => {
    // A case-insensitive volume resolves an existing directory under any case, so identity decides there; the case
    // spelling matters for the names that do not exist yet, which this home's empty store directory leaves.
    const fresh = { DSH_HOME: join(root, 'fresh', '.delo'), DSH_AGENTS_HOME: join(root, 'fresh', '.agents') }
    mkdirSync(fresh.DSH_HOME, { recursive: true })
    expect(classifyTarget(join(fresh.DSH_HOME, 'SKILLS', 'review', 'SKILL.md'), { env: fresh, caseInsensitive: insensitive }))
      .toEqual({ kind: 'skill', root: 'home' })
    expect(classifyTarget(join(fresh.DSH_HOME, 'Agents.MD'), { env: fresh, caseInsensitive: insensitive }))
      .toEqual({ kind: 'instructions', scope: 'global' })
    expect(classifyTarget(join(fresh.DSH_HOME, 'SKILLS', 'review', 'SKILL.md'), { env: fresh, caseInsensitive: sensitive }))
      .toBeUndefined()
  })

  it('a case variant of a project skill directory on a case-insensitive volume asks for consent', () => {
    expect(classifyTarget(join(root, 'work', '.Agents', 'SKILLS', 'lint', 'SKILL.md'), { env, caseInsensitive: insensitive }))
      .toEqual({ kind: 'skill', root: 'project' })
  })

  it('a case variant of a configured skill root on a case-insensitive volume asks for consent', () => {
    expect(classifyTarget(join(root, 'company', 'skills', 'lint', 'SKILL.md'), {
      env, skillRoots: [join(root, 'Company', 'Skills')], caseInsensitive: insensitive,
    })).toEqual({ kind: 'skill', root: 'custom' })
  })

  it('a case variant of a composition file on a case-insensitive volume asks for consent', () => {
    expect(classifyTarget(join(root, 'home', '.delo', 'Profiles', 'default', 'Cordis.Patch.YML'), {
      env,
      compositionFiles: [{ path: join(root, 'home', '.delo', 'profiles', 'default', 'cordis.patch.yml'), layer: 'profile' }],
      caseInsensitive: insensitive,
    })).toEqual({ kind: 'preset', layer: 'profile' })
  })

  it('the same case variants on a case-sensitive volume ask nothing', () => {
    expect(classifyTarget(join(root, 'work', 'agents.md'), { env, caseInsensitive: sensitive })).toBeUndefined()
    expect(classifyTarget(join(root, 'company', 'skills', 'lint', 'SKILL.md'), {
      env, skillRoots: [join(root, 'Company', 'Skills')], caseInsensitive: sensitive,
    })).toBeUndefined()
    expect(classifyTarget(join(root, 'work', '.Agents', 'SKILLS', 'lint', 'SKILL.md'), { env, caseInsensitive: sensitive })).toBeUndefined()
  })

  it('a case variant asks for consent when only the instruction root sits on a case-insensitive volume', () => {
    // The probe answers per directory: the root's volume folds the comparison even when the target's does not.
    mkdirSync(join(root, 'Company', 'skills'), { recursive: true })
    const rootOnly = (directory: string): boolean => directory === join(root, 'Company')
    expect(classifyTarget(join(root, 'Company', 'skills', 'lint', 'SKILL.md'), {
      env, skillRoots: [join(root, 'Company', 'Skills')], caseInsensitive: rootOnly,
    })).toEqual({ kind: 'skill', root: 'custom' })
  })
})

describe('a write to another name of an instruction-layer file', () => {
  it('a write to a hard link of the profile patch file asks for consent', () => {
    const profilePatch = join(env.DSH_HOME, 'profiles', 'default', 'cordis.patch.yml')
    mkdirSync(join(profilePatch, '..'), { recursive: true })
    writeFileSync(profilePatch, '[]\n')
    linkSync(profilePatch, join(root, 'work', 'rows.yml'))
    expect(classifyTarget(join(root, 'work', 'rows.yml'), {
      env, compositionFiles: [{ path: profilePatch, layer: 'profile' }], caseInsensitive: sensitive,
    })).toEqual({ kind: 'preset', layer: 'profile' })
  })

  it('a write to a hard link of the home AGENTS.md asks for consent', () => {
    linkSync(join(env.DSH_HOME, 'AGENTS.md'), join(root, 'work', 'src', 'rules.md'))
    expect(classifyTarget(join(root, 'work', 'src', 'rules.md'), { env, caseInsensitive: sensitive }))
      .toEqual({ kind: 'instructions', scope: 'global' })
  })
})

describe('the homes the loader resolved', () => {
  it('a write to the skill store of the home the loader resolved at mount asks after the environment names another', async () => {
    const saved = { home: process.env['DSH_HOME'], agents: process.env['DSH_AGENTS_HOME'] }
    process.env['DSH_HOME'] = env.DSH_HOME
    process.env['DSH_AGENTS_HOME'] = env.DSH_AGENTS_HOME
    const ctx = new Context()
    try {
      const consent = new InstructionConsent(ctx)
      process.env['DSH_HOME'] = join(root, 'other', '.delo')
      process.env['DSH_AGENTS_HOME'] = join(root, 'other', '.agents')
      expect(consent.review({ tool: 'write', path: join(env.DSH_HOME, 'skills', 'review', 'SKILL.md') }))
        .toMatchObject({ required: true })
      expect(consent.review({ tool: 'write', path: join(env.DSH_AGENTS_HOME, 'skills', 'review', 'SKILL.md') }))
        .toMatchObject({ required: true })
    } finally {
      for (const [key, value] of [['DSH_HOME', saved.home], ['DSH_AGENTS_HOME', saved.agents]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await ctx.fiber.dispose()
    }
  })
})

describe('the case-sensitivity probe', () => {
  it('agrees with the filesystem holding the temporary directory', () => {
    const directory = join(root, 'probe')
    mkdirSync(directory)
    writeFileSync(join(directory, 'Probe-File'), '')
    let folds: boolean
    try {
      realpathSync(join(directory, 'pROBE-fILE'))
      folds = true
    } catch {
      // ENOENT: the case-flipped spelling names no file, so this volume compares names exactly.
      folds = false
    }
    expect(probeCaseInsensitive(directory)).toBe(folds)
  })

  it('reports a directory whose case-flipped entry is another file case-sensitive', () => {
    const directory = join(root, 'two-files')
    mkdirSync(directory)
    writeFileSync(join(directory, 'Abc'), 'one')
    try {
      writeFileSync(join(directory, 'aBC'), 'two', { flag: 'wx' })
    } catch {
      // EEXIST: the volume folds case, so the two spellings cannot be two files here.
      return
    }
    expect(probeCaseInsensitive(directory)).toBe(false)
  })

  it('reports a directory whose case-flipped entry is the same file case-insensitive', () => {
    // Two spellings that name one inode are what a case-folding volume shows; a hard link reproduces it anywhere.
    const directory = join(root, 'one-file')
    mkdirSync(directory)
    writeFileSync(join(directory, 'Abc'), 'one')
    try {
      linkSync(join(directory, 'Abc'), join(directory, 'aBC'))
    } catch {
      // EEXIST: the volume folds case already, which is the answer this spec expects.
    }
    expect(probeCaseInsensitive(directory)).toBe(true)
  })

  it('reports a directory without a lettered entry case-insensitive, so its names compare folded', () => {
    const directory = join(root, 'numbers', '123')
    mkdirSync(join(directory, '456'), { recursive: true })
    const empty = join(root, 'empty-dir')
    mkdirSync(empty)
    expect(probeCaseInsensitive(directory)).toBe(true)
    expect(probeCaseInsensitive(join(directory, '456'))).toBe(true)
    expect(probeCaseInsensitive(empty)).toBe(true)
  })
})
