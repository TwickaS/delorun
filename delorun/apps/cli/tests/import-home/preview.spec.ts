/**
 * The preview and the report of a stock-home import as a person reads them:
 * the data first, then each category with what lands and what is held back,
 * the groups of what stays behind with their examples, the exact text shown
 * before each category's question, and no name or text printed with a
 * control character.
 */
import { describe, expect, it } from 'vitest'
import { DSH_IMPORT_LIMITS, parseRegistry, type DshHashedFile, type DshHomeImportPlan, type DshHomeImportReport, type DshImportLayer, type DshImportRegistry } from '@delorun/archive/dsh-import'
import { categoryOffered, categoryQuestion, categoryText, counted, PREVIEW_EXAMPLES, previewText, reportText, skillInstructionLines } from '../../src/import-home/preview.ts'

/**
 * One file of a plan.
 * @param path - its path.
 * @returns the file.
 */
function file(path: string): DshHashedFile {
  return { path, size: 1, dev: 1, ino: 1, mtimeMs: 1, ctimeMs: 1, nlink: 1, mode: 0o600, sha256: 'a'.repeat(64) }
}

/**
 * The workspace registrations of a plan.
 * @param overrides - the fields to change.
 * @returns the registrations.
 */
function registry(overrides: Partial<DshImportRegistry> = {}): DshImportRegistry {
  return {
    source: { file: file('storages/workspace.json'), sha256: 'a'.repeat(64) },
    registry: parseRegistry('{"unit":{"name":"workspace","version":2},"global":null}'),
    listed: [],
    workspaces: 0,
    mode: 'copy',
    ...overrides,
  }
}

/**
 * One layer of a plan.
 * @param overrides - the fields to change.
 * @returns the layer.
 */
function layer(overrides: Partial<DshImportLayer> = {}): DshImportLayer {
  return {
    source: { file: file('cordis.patch.yml'), sha256: 'a'.repeat(64) },
    kind: 'home-patch',
    target: 'cordis.patch.yml',
    state: 'new',
    carried: '- id: ui-chat\n',
    carriedLabels: ['ui-chat'],
    held: [],
    heldPath: undefined,
    heldText: undefined,
    expressions: 0,
    ...overrides,
  }
}

/** A plan that carries nothing and leaves nothing behind. */
const EMPTY: DshHomeImportPlan = {
  id: 'plan',
  source: '/stock',
  sourceDevice: 1,
  target: '/delorun',
  merge: false,
  limits: DSH_IMPORT_LIMITS,
  delorunBundles: [],
  chats: [],
  attachments: [],
  attachmentsPresent: 0,
  registry: undefined,
  profiles: [],
  layers: [],
  instructions: undefined,
  skills: [],
  credentials: undefined,
  skipped: [],
  skippedTotals: {},
  delorunChats: 0,
  bytes: 0,
  blockers: [],
}

const OPTIONS = { credentials: 'copied on a yes', categories: true }

describe('the preview', () => {
  it('says when there is nothing of a kind to copy and nothing stays behind', () => {
    expect(previewText(EMPTY, OPTIONS)).toBe([
      'DeepSeek Harness home: "/stock" (read only; nothing in it changes)',
      'Delorun home: "/delorun"',
      '',
      'Your chats and workspaces:',
      '  Chats: 0 chats to copy',
      '  Attachments: 0 files to copy',
      '  Workspaces: none to copy',
      '',
      'Asked about one by one, and copied only if you say yes:',
      '  Profiles: none to copy',
      '  Settings: none to copy',
      '  Instructions: none to copy',
      '  Skills: none to copy',
      '  In all 0 bytes to copy if you say yes to everything.',
      '',
      'Nothing is left behind.',
      '',
    ].join('\n'))
  })

  it('lists the data alone, and names the command that copies the rest, when it leaves the categories out', () => {
    const text = previewText({ ...EMPTY, profiles: [{ name: 'web', source: { file: file('p'), sha256: '' }, manifest: '{}', patch: undefined, bundles: [], plugins: [], carry: [] }] }, { credentials: 'not copied', categories: false })
    expect(text).toContain('  Workspaces: none to copy\n\nProfiles, settings, instructions, skills and stored keys are not copied here; run delorun import-home to review each and copy what you choose.\n')
    expect(text).not.toContain('"web"')
    expect(text).not.toContain('Asked about one by one')
  })

  it('names what is already in the Delorun home, how the workspaces land, that a chat with full access opens on the safer preset, each skill and the keys by name', () => {
    const plan: DshHomeImportPlan = {
      ...EMPTY,
      chats: [{ path: 'sessions/_no-cwd/a', id: 'a', cwd: undefined, files: [file('a')], state: 'new' }, { path: 'sessions/_no-cwd/b', id: 'b', cwd: undefined, files: [file('b')], state: 'present' }],
      attachments: [file('x')],
      attachmentsPresent: 2,
      registry: registry({ workspaces: 3, mode: 'merge' }),
      skills: [{ path: 'skills/review', files: [file('skills/review/SKILL.md')], description: 'Reviews \u001b[2J', instructions: '# review\n', bytes: 9 }, { path: 'skills/b\u001bad', files: [file('x'), file('y')], description: undefined, instructions: undefined, bytes: 1 }],
      credentials: { file: file('.credentials.yaml'), entries: [{ name: 'A', state: 'offered' }, { name: 'B', state: 'present' }, { name: 'C', state: 'taken' }, { name: 'D', state: 'not-carried' }] },
      bytes: 1,
    }
    const text = previewText(plan, OPTIONS)
    expect(text).toContain('  Chats: 1 chat to copy; 1 already in the Delorun home\n')
    expect(text).toContain('  Attachments: 1 file to copy; 2 already in the Delorun home\n')
    expect(text).toContain('  Workspaces: 3 registrations, added to the Delorun home\'s workspace list\n')
    expect(text).toContain('  A chat that ran with full access opens on the safer preset until you allow full access for its workspace in Delorun.\n')
    expect(text).toContain('  Skills (a skill can tell the agent what to do and which commands to run):\n    "review": 1 file, 9 bytes; "Reviews \\u001b[2J"\n    "b\\u001bad": 2 files, 1 byte\n')
    expect(text).toContain([
      '  Stored keys (copied on a yes):',
      '    "A": can be copied',
      '    "B": already in the Delorun home',
      '    "C": not copied: the Delorun home holds another value',
      '    "D": not copied: only the DeepSeek key is offered; add other keys again in Delorun',
    ].join('\n'))
    expect(text).toContain('  In all 1 byte to copy if you say yes to everything.')
    expect(text).not.toMatch(/\u001b/u)
    expect(previewText({ ...plan, registry: registry({ workspaces: 1, mode: 'present' }), credentials: { file: file('.credentials.yaml'), entries: [] } }, OPTIONS))
      .toContain('  Workspaces: 1 registration, already in the Delorun home\'s workspace list\n')
    expect(previewText({ ...plan, credentials: { file: file('.credentials.yaml'), entries: [] } }, OPTIONS)).not.toContain('Stored keys')
  })

  it('names every workspace by its title with its folder, the chats it carries, and why a held one is held back with its chats', () => {
    const text = previewText({ ...EMPTY, registry: registry({ workspaces: 1, listed: [
      { id: 'w1', title: 'work \u200b', path: '/work', chats: 2, held: undefined },
      { id: 'w2', title: 'keys', path: '/home/me/.ssh', chats: 0, held: 'a hidden folder of your home folder, where settings and keys live' },
    ] }) }, OPTIONS)
    expect(text).toContain([
      '  Workspaces: 1 registration, copied as the Delorun home\'s workspace list',
      '    "work \\u200b" at "/work": 2 chats',
      '    "keys" at "/home/me/.ssh": held back, with its chats: a hidden folder of your home folder, where settings and keys live',
    ].join('\n'))
  })

  it('shows each settings layer with the rows that land and every row held back with its reason, and where the held rows go', () => {
    const plan: DshHomeImportPlan = {
      ...EMPTY,
      layers: [
        layer({ expressions: 2, heldPath: 'archive/stock-import/import-plan/held/cordis.patch.yml', heldText: '# held\n', held: [{ label: 'sandbox', reason: 'not-understood', detail: 'a row the import does not carry\u0007' }, { label: 'insert ./evil', reason: 'code' }] }),
        layer({ kind: 'settings', target: 'settings.yaml', carriedLabels: [] }),
        layer({ target: 'a.yml', state: 'present' }),
        layer({ target: 'b.yml', state: 'taken', carried: undefined, carriedLabels: [] }),
        layer({ target: 'c.yml', carried: undefined, carriedLabels: [] }),
      ],
    }
    expect(previewText(plan, OPTIONS)).toContain([
      '  Settings:',
      '    "cordis.patch.yml" (the home patch, which applies to every profile): lands with 1 row: "ui-chat"',
      '      It holds 2 !!js expressions; none of them is carried.',
      '      Held back, written where nothing reads it, "archive/stock-import/import-plan/held/cordis.patch.yml":',
      '        "sandbox": it is not one of the settings the import carries: the studio\'s looks and layout, the language and the default model by name (a row the import does not carry\\u0007)',
      '        "insert ./evil": it loads a plugin row, which the import never carries; add it again yourself if you trust it',
      '    "settings.yaml" (settings from an earlier release, which the next start moves into the profile): lands with 0 rows',
      '    "a.yml" (the home patch, which applies to every profile): already in the Delorun home',
      '    "b.yml" (the home patch, which applies to every profile): nothing lands: the Delorun home holds its own file of that name',
      '    "c.yml" (the home patch, which applies to every profile): nothing lands',
      '  Instructions',
    ].join('\n'))
  })

  it('lists each profile\'s packages, patch layer and carry notes, and the install command only when something is to install', () => {
    const plan: DshHomeImportPlan = {
      ...EMPTY,
      profiles: [
        { name: 'web', source: { file: file('profiles/web/package.json'), sha256: '' }, manifest: '{}', patch: layer({ kind: 'profile-patch', target: 'profiles/web/cordis.patch.yml' }), bundles: [], carry: ['The row x\u001b[2J does not land.'], plugins: [
          { name: 'a', kind: 'bundle', status: 'carried', note: 'ships' },
          { name: 'b', kind: 'plugin', status: 'install', note: 'from ^1' },
          { name: 'c', kind: 'bundle', status: 'added', note: 'Delorun\'s' },
          { name: 'd', kind: 'bundle', status: 'not-carried', note: 'retired' },
        ] },
        { name: 'plain', source: { file: file('profiles/plain/package.json'), sha256: '' }, manifest: '{}', patch: undefined, bundles: [], carry: [], plugins: [{ name: 'a', kind: 'bundle', status: 'carried', note: 'ships' }] },
      ],
    }
    expect(previewText(plan, OPTIONS)).toContain([
      '  Profiles (each keeps its name and loads no script, path or link of the stock profile):',
      '    "web":',
      '      carried      "a" (ships)',
      '      to install   "b" (from ^1)',
      '      added        "c" (Delorun\'s)',
      '      not carried  "d" (retired)',
      '      "profiles/web/cordis.patch.yml" (the profile\'s patch layer): lands with 1 row: "ui-chat"',
      '      The row x\\u001b[2J does not land.',
      '      After the import, delorun plugin --profile web install installs its plugins with pnpm. A plugin\'s install script runs only after you approve it.',
      '    "plain":',
      '      carried      "a" (ships)',
      '  Settings: none to copy',
    ].join('\n'))
  })

  it('says how many lines the instructions hold, or that the Delorun home holds them', () => {
    const instructions = { source: { file: file('AGENTS.md'), sha256: '' }, state: 'new' as const, text: '# notes\n', lines: 1 }
    expect(previewText({ ...EMPTY, instructions }, OPTIONS)).toContain('  Instructions: "AGENTS.md", 1 line, which every chat reads; shown before you are asked\n')
    expect(previewText({ ...EMPTY, instructions: { ...instructions, state: 'present' } }, OPTIONS)).toContain('  Instructions: "AGENTS.md", already in the Delorun home\n')
  })

  it('groups what stays behind by reason, counts every entry, and names at most a few paths of each', () => {
    const listed = Array.from({ length: PREVIEW_EXAMPLES + 2 }, (_, index) => ({ path: `logs/${String(index)}`, reason: 'logs' as const }))
    const text = previewText({
      ...EMPTY,
      skipped: [{ path: 'x\u202e', reason: 'unknown', detail: 'it holds \u0007' }, ...listed],
      // The plan lists a bounded number per reason; the totals count every entry, the unlisted ones included.
      skippedTotals: { logs: 250, unknown: 1, cache: 3 },
    }, OPTIONS)
    expect(text).toContain('What stays behind, and why:\n  1 entry: an entry the import does not know, so it is not carried\n    "x\\u202e": it holds \\u0007\n')
    expect(text).toContain('  250 entries: logs, which Delorun writes its own of\n    "logs/0"\n')
    expect(text).toContain('    "logs/4"\n    and 245 more\n')
    expect(text).toContain('  3 entries: a cache, which is built again from what the import carries\n')
    expect(text).not.toContain('"logs/5"')
    // The groups follow the order of the reasons, not the order the walk met them in.
    expect(text.indexOf('an entry the import does not know')).toBeLessThan(text.indexOf('logs, which Delorun'))
  })
})

describe('the categories', () => {
  const instructions = { source: { file: file('AGENTS.md'), sha256: '' }, state: 'new' as const, text: '# notes \u001b[31m\r\nsecond\n', lines: 2 }
  const full: DshHomeImportPlan = {
    ...EMPTY,
    profiles: [{ name: 'web', source: { file: file('profiles/web/package.json'), sha256: '' }, manifest: '{\n  "private": true\n}\n', patch: undefined, bundles: [], plugins: [], carry: [] }],
    layers: [layer()],
    instructions,
    skills: [{ path: 'skills/a', files: [file('skills/a/SKILL.md'), { ...file('skills/a/run.sh'), size: 12 }], description: undefined, instructions: '---\nname: a\n---\nRun \u202erun.sh\n', bytes: 13 }, { path: 'skills/b', files: [file('skills/b/x')], description: undefined, instructions: undefined, bytes: 1 }],
    credentials: { file: file('.credentials.yaml'), entries: [{ name: 'DEEPSEEK_API_KEY', state: 'offered' }, { name: 'llm-deepseek/main', state: 'offered' }, { name: 'X', state: 'not-carried' }] },
  }

  it('offers a category only when a yes would land something', () => {
    for (const category of ['profiles', 'settings', 'instructions', 'skills', 'credentials'] as const) {
      expect(categoryOffered(full, category)).toBe(true)
      expect(categoryOffered(EMPTY, category)).toBe(false)
    }
    expect(categoryOffered({ ...EMPTY, layers: [layer({ state: 'taken', carried: undefined })] }, 'settings')).toBe(false)
    expect(categoryOffered({ ...EMPTY, layers: [layer({ carried: undefined, heldText: '# held\n', heldPath: 'h' })] }, 'settings')).toBe(true)
    expect(categoryOffered({ ...EMPTY, layers: [layer({ state: 'present' })] }, 'settings')).toBe(false)
    expect(categoryOffered({ ...EMPTY, instructions: { ...instructions, state: 'present' } }, 'instructions')).toBe(false)
    expect(categoryOffered({ ...EMPTY, credentials: { file: file('.credentials.yaml'), entries: [{ name: 'X', state: 'present' }] } }, 'credentials')).toBe(false)
  })

  it('asks each category its own question, each answered no unless the person says yes', () => {
    expect(categoryQuestion(full, 'profiles')).toBe('Copy 1 profile as shown, with their held-back rows written where nothing reads them? [y/N] ')
    expect(categoryQuestion(full, 'settings')).toBe('Copy these settings into the Delorun home, with the held-back rows written where nothing reads them? [y/N] ')
    expect(categoryQuestion(full, 'instructions')).toBe('Copy these instructions? Every chat in Delorun reads them. [y/N] ')
    expect(categoryQuestion(full, 'skills')).toBe('Copy 2 skills? A skill can tell the agent what to do. [y/N] ')
    expect(categoryQuestion(full, 'credentials')).toBe('Copy 2 stored keys (DEEPSEEK_API_KEY, llm-deepseek/main) into the Delorun home\'s credentials document, readable by you alone? [y/N] ')
    expect(categoryQuestion(EMPTY, 'credentials')).toBe('Copy 0 stored keys () into the Delorun home\'s credentials document, readable by you alone? [y/N] ')
  })

  it('shows every line of the settings that land, escaped, and nothing of a layer that does not land', () => {
    const long = Array.from({ length: 120 }, (_, index) => `- id: row-${String(index)}`).join('\n')
    const text = categoryText({ ...EMPTY, layers: [
      layer({ carried: '- id: ui-chat\n  config:\n    title: "\u001b[2J"\n' }),
      layer({ target: 'settings.yaml', carried: long }),
      layer({ target: 'present.yml', state: 'present' }),
      layer({ target: 'held.yml', carried: undefined }),
    ] }, 'settings')
    expect(text.slice(0, 4)).toEqual(['"cordis.patch.yml" lands as:', '  | - id: ui-chat', '  |   config:', '  |     title: "\\u001b[2J"'])
    expect(text[4]).toBe('"settings.yaml" lands as:')
    expect(text).toHaveLength(4 + 1 + 120)
    expect(text.at(-1)).toBe('  | - id: row-119')
    expect(text.join('\n')).not.toMatch(/present\.yml|held\.yml/u)
  })

  it('shows each profile\'s manifest and the patch layer that lands, in full', () => {
    const plan: DshHomeImportPlan = { ...full, profiles: [...full.profiles, { name: 'ops', source: { file: file('profiles/ops/package.json'), sha256: '' }, manifest: '{}\n', patch: layer({ kind: 'profile-patch', target: 'profiles/ops/cordis.patch.yml', carried: '- id: ui-theme\n' }), bundles: [], plugins: [], carry: [] }, { name: 'held', source: { file: file('profiles/held/package.json'), sha256: '' }, manifest: '{}\n', patch: layer({ kind: 'profile-patch', target: 'profiles/held/cordis.patch.yml', carried: undefined }), bundles: [], plugins: [], carry: [] }] }
    expect(categoryText(plan, 'profiles')).toEqual([
      '"profiles/web/package.json" lands as:', '  | {', '  |   "private": true', '  | }',
      '"profiles/ops/package.json" lands as:', '  | {}', '"profiles/ops/cordis.patch.yml" lands as:', '  | - id: ui-theme',
      '"profiles/held/package.json" lands as:', '  | {}',
    ])
  })

  it('shows the whole instructions escaped, each skill\'s files with their sizes, and a skill\'s own instructions on request', () => {
    expect(categoryText(full, 'instructions')).toEqual(['"AGENTS.md" in full:', '  | # notes \\u001b[31m', '  | second'])
    expect(categoryText(full, 'skills')).toEqual(['"skills/a":', '  "SKILL.md": 1 byte', '  "run.sh": 12 bytes', '"skills/b":', '  "x": 1 byte'])
    expect(skillInstructionLines(full.skills[0] as DshHomeImportPlan['skills'][number])).toEqual(['"skills/a/SKILL.md" in full:', '  | ---', '  | name: a', '  | ---', '  | Run \\u202erun.sh'])
    expect(skillInstructionLines(full.skills[1] as DshHomeImportPlan['skills'][number])).toEqual(['"skills/b" holds no SKILL.md.'])
    expect(categoryText(full, 'credentials')).toEqual([])
  })
})

describe('the chats that stopped inside a turn', () => {
  it('says how many stay behind and where the person can still read them, in the preview and in the report', () => {
    const one = { ...EMPTY, skippedTotals: { 'unfinished-turn': 1 } }
    const two = { ...EMPTY, skippedTotals: { 'unfinished-turn': 2 } }
    const sentence = (count: string, verb: string, it: string, its: string): string => `${count} stopped in the middle of a turn and ${verb} behind, because continuing ${it} here would offer ${its} unfinished tool calls for retry. You can still read ${it} in DeepSeek Harness, whose home "/stock" the import leaves untouched; finish or close ${it} there and import again to bring ${it} over.`
    expect(previewText(one, OPTIONS)).toContain(`\n  ${sentence('1 chat', 'stays', 'it', 'its')}\n`)
    expect(previewText(two, OPTIONS)).toContain(`\n  ${sentence('2 chats', 'stay', 'them', 'their')}\n`)
    const report: DshHomeImportReport = { chats: 0, chatsPresent: 0, attachments: 0, workspaces: { count: 0, mode: 'none' }, profiles: [], documents: [], held: [], skills: 0, credentials: [], skipped: 2, bytes: 0 }
    expect(reportText(report, two)).toContain(`\n${sentence('2 chats', 'stay', 'them', 'their')}\n`)
    expect(previewText(EMPTY, OPTIONS)).not.toContain('middle of a turn')
  })
})

describe('the report', () => {
  const report: DshHomeImportReport = { chats: 1, chatsPresent: 0, attachments: 0, workspaces: { count: 2, mode: 'copy' }, profiles: [], documents: [], held: [], skills: 0, credentials: [], skipped: 1, bytes: 1 }

  it('counts the workspaces it carried, and none it found already there', () => {
    expect(reportText(report, EMPTY)).toBe('Imported 1 chat, 0 attachment files, 2 workspace registrations, 0 profiles, 0 documents, 0 skills and 0 stored keys.\n1 entry stayed behind. The DeepSeek Harness home was only read, and still holds everything.\n')
    expect(reportText({ ...report, workspaces: { count: 2, mode: 'present' } }, EMPTY)).toContain(', 0 workspace registrations,')
    expect(reportText({ ...report, workspaces: { count: 0, mode: 'none' }, skipped: 2 }, EMPTY)).toContain('2 entries stayed behind.')
    expect(counted(1, 'entry', 'entries')).toBe('1 entry')
  })

  it('names the held-back files, and the install and start commands of the profiles that landed only', () => {
    const plugins = [{ name: 'b', kind: 'plugin' as const, status: 'install' as const, note: 'from ^1' }]
    const profile = (name: string): DshHomeImportPlan['profiles'][number] => ({ name, source: { file: file(`profiles/${name}/package.json`), sha256: '' }, manifest: '{}', patch: undefined, bundles: [], plugins, carry: [] })
    const plan: DshHomeImportPlan = { ...EMPTY, profiles: [profile('web'), profile('declined')] }
    const text = reportText({ ...report, profiles: ['web'], held: ['archive/stock-import/import-plan/held/cordis.patch.yml'] }, plan)
    expect(text).toContain('Held-back rows are in "archive/stock-import/import-plan/held/cordis.patch.yml"; nothing there takes effect.\n')
    expect(text).toContain('To install the plugins of the profile "web": delorun plugin --profile web install\nTo start the profile "web": delorun --profile web\n')
    expect(text).not.toContain('declined')
  })
})
