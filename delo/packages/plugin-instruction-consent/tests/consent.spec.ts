/**
 * Specs of `@delo/plugin-instruction-consent`: the classifier's targets — the
 * skill stores of every scope, the preset declaration files, the folder and
 * home `AGENTS.md` — the review notes' effect text and verbatim diff, the
 * `writeConsent` review's verdicts, and the switch that mounts the service or
 * nothing.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyTarget, INSTRUCTION_FILE_NAMES, reviewNote } from '../src/classify.ts'
import { apply, Config, InstructionConsent } from '../src/index.ts'

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

  it('classifies every instruction file name the loader reads, as folder-scoped or home-scoped', () => {
    // The loader's own default list is the source: every name it loads is a name this classifier covers.
    for (const name of INSTRUCTION_FILE_NAMES) {
      expect(classifyTarget(`/work/app/${name}`, { env: ENV }), name).toEqual({ kind: 'instructions', scope: 'folder' })
      expect(classifyTarget(`/work/app/nested/${name}`, { env: ENV }), name).toEqual({ kind: 'instructions', scope: 'folder' })
      expect(classifyTarget(`/home/person/.delo/${name}`, { env: ENV }), name).toEqual({ kind: 'instructions', scope: 'global' })
      expect(classifyTarget(`/home/person/.agents/${name}`, { env: ENV }), name).toEqual({ kind: 'instructions', scope: 'global' })
    }
    expect([...INSTRUCTION_FILE_NAMES]).toEqual(['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'])
  })

  it('classifies a file under a skill root the provider configured', () => {
    // A deployment's own skill directory comes from the mounted provider, not from a literal in this module.
    expect(classifyTarget('/opt/company/skills/review/SKILL.md', { env: ENV })).toBeUndefined()
    expect(classifyTarget('/opt/company/skills/review/SKILL.md', { env: ENV, skillRoots: ['/opt/company/skills'] }))
      .toEqual({ kind: 'skill', root: 'custom' })
    // The project directories stay lexical, so a nested project skill classifies without a provider lookup.
    expect(classifyTarget('/work/app/.agents/skills/lint/references/cheap.md', { env: ENV })).toEqual({ kind: 'skill', root: 'project' })
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

  it('requires consent for a write to a skill under a root the mounted provider configured', () => {
    let roots: string[] = ['/opt/company/skills']
    ctx.provide('skills', { configuredRoots: () => roots } as never)
    const verdict = consent.review({ tool: 'write', path: '/opt/company/skills/review/SKILL.md', diff: { old: null, new: 'body' } })
    expect(verdict).toMatchObject({ required: true })
    expect((verdict as { required: true; note: string }).note)
      .toContain('A model-authored write to a skill: its instructions load in every future chat.')
    // The provider's roots are read on every review, so a root it stops naming stops being reviewed.
    roots = []
    expect(consent.review({ tool: 'write', path: '/opt/company/skills/review/SKILL.md' })).toBeUndefined()
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

  it('mounts the writeConsent service when on, and leaves the one mode-guard slot to its owner', () => {
    const ctx = new Context()
    try {
      apply(ctx, { enabled: true })
      expect(ctx.get('writeConsent')).toBeInstanceOf(InstructionConsent)
      // A135: the session-mode seam keeps one provider, the full-access consent
      // of @delo/plugin-permission-defaults, so this plugin mounts no guard. The
      // seam itself is proven by sandbox-policy's own spec.
      expect(ctx.get('sandboxModeGuard')).toBeUndefined()
    } finally {
      void ctx.fiber.dispose()
    }
  })

  it('mounts nothing when off, so the seam reads as unmounted', () => {
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
