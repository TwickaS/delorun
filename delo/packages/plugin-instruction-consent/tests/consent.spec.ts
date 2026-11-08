/**
 * Specs of `@delo/plugin-instruction-consent`: the classifier's targets — the
 * skill stores of every scope, the preset declaration files, the folder and
 * home `AGENTS.md` — the review notes' effect text and verbatim diff, the
 * `writeConsent` review's verdicts, and the switch that mounts both services
 * or nothing.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyTarget, reviewNote } from '../src/classify.ts'
import { allowEveryModeChange, apply, Config, InstructionConsent } from '../src/index.ts'

/** The environment the classifier's homes resolve from in this suite. */
const ENV = { DSH_HOME: '/home/person/.delo', DSH_AGENTS_HOME: '/home/person/.agents' }

describe('the classifier', () => {
  it('classifies the skill stores of every scope', () => {
    expect(classifyTarget('/home/person/.delo/skills/pdf/SKILL.md', { env: ENV })).toEqual({ kind: 'skill', root: 'home' })
    expect(classifyTarget('/home/person/.agents/skills/review/scripts/run.sh', { env: ENV })).toEqual({ kind: 'skill', root: 'shared' })
    expect(classifyTarget('/work/app/.dsh/skills/lint/SKILL.md', { env: ENV })).toEqual({ kind: 'skill', root: 'project' })
    expect(classifyTarget('/work/app/.agents/skills/lint/references/cheap.md', { env: ENV })).toEqual({ kind: 'skill', root: 'project' })
  })

  it('classifies a preset declaration file, and no other file of the preset directory', () => {
    expect(classifyTarget('/work/app/presets/reviewer.patch.yml', { env: ENV })).toEqual({ kind: 'preset' })
    expect(classifyTarget('/work/app/presets/reviewer.yaml', { env: ENV })).toEqual({ kind: 'preset' })
    expect(classifyTarget('/work/app/presets/README.md', { env: ENV })).toBeUndefined()
    expect(classifyTarget('/work/app/presets/nested/deep.patch.yml', { env: ENV })).toBeUndefined()
  })

  it('classifies a folder AGENTS.md as folder-scoped and a home AGENTS.md as global', () => {
    expect(classifyTarget('/work/app/AGENTS.md', { env: ENV })).toEqual({ kind: 'instructions', scope: 'folder' })
    expect(classifyTarget('/work/app/nested/AGENTS.md', { env: ENV })).toEqual({ kind: 'instructions', scope: 'folder' })
    expect(classifyTarget('/home/person/.delo/AGENTS.md', { env: ENV })).toEqual({ kind: 'instructions', scope: 'global' })
    expect(classifyTarget('/home/person/.agents/AGENTS.md', { env: ENV })).toEqual({ kind: 'instructions', scope: 'global' })
  })

  it('classifies no unrelated target', () => {
    for (const path of [
      '/work/app/src/index.ts',
      '/work/app/skills.md',
      '/work/app/presets-backup/reviewer.patch.yml',
      '/work/app/.dsh/config.json',
      '/home/person/.delo/runtimes/v1.2.3/lib/index.js',
      '',
    ]) {
      expect(classifyTarget(path, { env: ENV }), path).toBeUndefined()
    }
  })

  it('resolves the homes from this process when no environment is given', () => {
    process.env['DSH_HOME'] = '/suite/home'
    try {
      expect(classifyTarget('/suite/home/skills/x/SKILL.md')).toEqual({ kind: 'skill', root: 'home' })
    } finally {
      delete process.env['DSH_HOME']
    }
  })
})

describe('the review note', () => {
  it('names the effect of the target\'s scope', () => {
    expect(reviewNote({ kind: 'skill', root: 'home' })).toContain('A model-authored write to a skill: its instructions load in every future chat.')
    expect(reviewNote({ kind: 'skill', root: 'project' })).toContain('its instructions load in every future chat in this project.')
    expect(reviewNote({ kind: 'preset' })).toContain('A model-authored write to a preset: its instructions load in every future chat this preset composes.')
    expect(reviewNote({ kind: 'instructions', scope: 'folder' })).toContain('A model-authored write to AGENTS.md: these instructions load in every future chat that works in this folder.')
    expect(reviewNote({ kind: 'instructions', scope: 'global' })).toContain('A model-authored write to the home AGENTS.md: these instructions load in every future chat.')
    for (const note of [
      reviewNote({ kind: 'skill', root: 'home' }),
      reviewNote({ kind: 'preset' }),
      reviewNote({ kind: 'instructions', scope: 'folder' }),
    ]) {
      expect(note).toContain('Nothing is written until you allow it.')
    }
  })

  it('carries every diff representation verbatim', () => {
    expect(reviewNote({ kind: 'skill', root: 'home' }, { old: null, new: 'body text' })).toContain(
      'The diff, verbatim:\n--- old ---\n(the write tool does not carry the previous text)\n--- new ---\nbody text',
    )
    expect(reviewNote({ kind: 'preset' }, { old: 'before', new: 'after' })).toContain('The diff, verbatim:\n--- old ---\nbefore\n--- new ---\nafter')
    expect(reviewNote({ kind: 'preset' }, '*** Update File: presets/reviewer.patch.yml\n@@\n')).toContain(
      'The diff, verbatim:\n*** Update File: presets/reviewer.patch.yml\n@@\n',
    )
    expect(reviewNote({ kind: 'preset' })).toContain('The diff, verbatim:\n(the tool carries no diff)')
  })
})

describe('the writeConsent review', () => {
  let ctx: Context
  let consent: InstructionConsent

  beforeEach(() => {
    process.env['DSH_HOME'] = '/home/person/.delo'
    process.env['DSH_AGENTS_HOME'] = '/home/person/.agents'
    ctx = new Context()
    consent = new InstructionConsent(ctx)
  })

  afterEach(async () => {
    delete process.env['DSH_HOME']
    delete process.env['DSH_AGENTS_HOME']
    await ctx.fiber.dispose()
  })

  it('requires consent for an instruction-layer write, with the effect and the diff in the note', () => {
    const verdict = consent.review({ tool: 'write', path: '/work/app/presets/reviewer.patch.yml', diff: { old: null, new: 'rows' } })
    expect(verdict).toMatchObject({ required: true })
    const note = (verdict as { required: true; note: string }).note
    expect(note).toContain('its instructions load in every future chat this preset composes')
    expect(note).toContain('rows')
  })

  it('requires consent for a workspace AGENTS.md write and carries the edit pair', () => {
    const verdict = consent.review({ tool: 'edit', path: '/work/app/AGENTS.md', diff: { old: 'old rules', new: 'new rules' } })
    expect(verdict).toMatchObject({ required: true })
    const note = (verdict as { required: true; note: string }).note
    expect(note).toContain('these instructions load in every future chat that works in this folder')
    expect(note).toContain('--- old ---\nold rules\n--- new ---\nnew rules')
  })

  it('needs no consent for an unrelated write', () => {
    expect(consent.review({ tool: 'write', path: '/work/app/src/index.ts', diff: { old: null, new: 'export {}' } })).toBeUndefined()
    expect(consent.review({ tool: 'apply_patch', path: '/work/app/README.md', diff: '*** Update File: README.md\n' })).toBeUndefined()
  })
})

describe('the instruction_layer_consent switch', () => {
  it('defaults to off, the parity value', () => {
    expect(Config()).toEqual({ enabled: false })
  })

  it('mounts both services when on, and the mounted guard refuses no mode change', () => {
    const ctx = new Context()
    try {
      apply(ctx, { enabled: true })
      expect(ctx.get('writeConsent')).toBeInstanceOf(InstructionConsent)
      const guard = ctx.get('sandboxModeGuard') as unknown as (() => string | undefined) | undefined
      expect(guard).toBe(allowEveryModeChange)
      expect(guard?.()).toBeUndefined()
    } finally {
      void ctx.fiber.dispose()
    }
  })

  it('mounts nothing when off, so both seams read as unmounted', () => {
    const ctx = new Context()
    try {
      apply(ctx, { enabled: false })
      expect(ctx.get('writeConsent')).toBeUndefined()
      expect(ctx.get('sandboxModeGuard')).toBeUndefined()
    } finally {
      void ctx.fiber.dispose()
    }
  })
})
