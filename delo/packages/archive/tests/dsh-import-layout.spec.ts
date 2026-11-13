/**
 * The name rules and the tables of the stock-home import: which names it
 * carries, how a Session directory's files are read, the reason every root
 * entry it knows stays or goes, and the sentences a person reads.
 */
import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import {
  attachmentAddress,
  carryRefusalNotes,
  DSH_HOME_ROOT_ENTRIES,
  isPackageName,
  isRegistrySpec,
  splitPatchLayer,
  splitSettingsLayer,
  DSH_IMPORT_SKIP_REASONS,
  DSH_IMPORT_SKIP_SENTENCES,
  isProfileName,
  isProjectName,
  isSafeSegment,
  isSessionName,
  resolveDshImportLimits,
  sessionFileKind,
} from '../src/dsh-import/index.ts'

describe('the name rules', () => {
  it('carries a segment only when it holds no separator, control or reserved device name', () => {
    for (const name of ['notes.md', 'a b', 'résumé', '..hidden', '.dsh']) expect(isSafeSegment(name)).toBe(true)
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a\u0000b', 'a\nb', 'a\u001bb', 'a\u0085b', 'a\u202eb', 'a\u2028b', 'NUL', 'com1.txt', 'x'.repeat(256), 'é'.repeat(128)]) {
      expect(isSafeSegment(name)).toBe(false)
    }
  })

  it('reads the project, Session and profile names upstream writes', () => {
    expect(isProjectName('_no-cwd')).toBe(true)
    expect(isProjectName('--home-me-proj~0020x--')).toBe(true)
    expect(isProjectName('home-me-proj')).toBe(false)
    expect(isProjectName('----')).toBe(false)
    expect(isSessionName('0190f-ab_C.d~002E')).toBe(true)
    expect(isSessionName('a b')).toBe(false)
    expect(isSessionName('~zz00')).toBe(false)
    expect(isSessionName('a'.repeat(256))).toBe(false)
    expect(isProfileName('web')).toBe(true)
    expect(isProfileName('my.profile-2_x')).toBe(true)
    for (const name of ['-web', 'node_modules', 'a b', 'a;b', 'w'.repeat(65), '.hidden']) expect(isProfileName(name)).toBe(false)
  })

  it('tells a compressed generation, an uncompressed one, runtime state and anything else apart', () => {
    expect(sessionFileKind('session.jsonl.zstd')).toEqual({ kind: 'generation', version: 0 })
    expect(sessionFileKind('session.v4.jsonl.zstd')).toEqual({ kind: 'generation', version: 4 })
    expect(sessionFileKind('session.v4.jsonl')).toEqual({ kind: 'uncompressed' })
    expect(sessionFileKind('session.lock')).toEqual({ kind: 'runtime-state' })
    expect(sessionFileKind('session.v4.jsonl.zstd.0a1b.tmp')).toEqual({ kind: 'runtime-state' })
    expect(sessionFileKind('session.migration.x.jsonl.zstd.tmp-1')).toEqual({ kind: 'runtime-state' })
    expect(sessionFileKind('session.V4.jsonl.zstd')).toEqual({ kind: 'unknown' })
    expect(sessionFileKind('notes.zstd')).toEqual({ kind: 'unknown' })
  })
})

describe('the tables', () => {
  it('has a sentence for every reason, and names no root entry twice', () => {
    expect(Object.keys(DSH_IMPORT_SKIP_SENTENCES).sort()).toEqual([...DSH_IMPORT_SKIP_REASONS].sort())
    expect(DSH_HOME_ROOT_ENTRIES['secrets']).toEqual({ kind: 'skip', reason: 'delo-entry' })
    expect(Object.hasOwn(DSH_HOME_ROOT_ENTRIES, 'constructor')).toBe(false)
  })

  it('limits one file to the total the person gives, and keeps contract C8\'s numbers otherwise', () => {
    expect(resolveDshImportLimits()).toEqual({ maxEntries: 100_000, maxFileBytes: 1024 ** 3, maxTotalBytes: 4 * 1024 ** 3 })
    expect(resolveDshImportLimits(10)).toEqual({ maxEntries: 100_000, maxFileBytes: 10, maxTotalBytes: 10 })
    expect(resolveDshImportLimits(8 * 1024 ** 3)).toMatchObject({ maxFileBytes: 1024 ** 3, maxTotalBytes: 8 * 1024 ** 3 })
  })
})

describe('the profile helpers', () => {
  it('counts !!js and !js tags at any depth without evaluating them', () => {
    expect(splitPatchLayer('- id: a\n  config:\n    x: !!js 1\n    y: [!js "2", 3]\n    z: !!js {a: 1}\n').expressions).toBe(3)
    expect(splitPatchLayer('[]\n').expressions).toBe(0)
    expect(splitPatchLayer('- id: a\n  config: { x: !!str js }\n').expressions).toBe(0)
    expect(splitPatchLayer('- id: [x: !!js 1\n').expressions).toBe(1)
  })

  it('says what a carry refusal about a row the profile itself holds means', () => {
    expect(carryRefusalNotes({ code: 'ROW_NOT_CARRIED', message: '', subjects: [{ kind: 'row', name: 'own-row', layer: 'profile-patch' }], remedies: [] }, false)).toEqual(['The row own-row does not land in this profile: it is held back.'])
    expect(carryRefusalNotes({ code: 'UNNAMED_CHANGE', message: '', subjects: [{ kind: 'configuration', name: 'x', layer: 'home-patch' }], remedies: [] }, true)).toEqual(['The Delorun home patch\'s settings for x will apply to this profile too.'])
    expect(carryRefusalNotes({ code: 'ROW_NOT_CARRIED', message: '', subjects: [{ kind: 'row', name: 'r', layer: 'home-patch' }], remedies: [] }, true)).toEqual(['The stock home patch\'s row r will not apply: the Delorun home keeps its own home patch.'])
    expect(carryRefusalNotes({ code: 'CONFIGURATION_NOT_CARRIED', message: '', subjects: [{ kind: 'configuration', name: 'c', layer: 'home-patch' }], remedies: [] }, false)).toEqual(['The stock home patch\'s settings for c will not apply: it is held back.'])
    // The plugin list already names a plugin the import does not carry, so the note does not repeat it.
    expect(carryRefusalNotes({ code: 'LOCAL_PLUGIN_NOT_CARRIED', message: '', subjects: [{ kind: 'row', name: 'p', layer: 'profile-patch' }], remedies: [] }, false)).toEqual([])
  })

  it('carries a dependency only by a registry name with a version range or a tag', () => {
    for (const name of ['plugin', '@scope/plugin', 'a.b_c-d~e']) expect(isPackageName(name)).toBe(true)
    for (const name of ['Plugin', '../plugin', '@scope', 'a b', 'a\u001bb', 'x'.repeat(215), '.hidden']) expect(isPackageName(name)).toBe(false)
    for (const spec of ['1.2.3', '^1.0.0', '>=1 <2', '*', 'latest', 'next']) expect(isRegistrySpec(spec)).toBe(true)
    for (const spec of ['file:../x', 'link:/opt/x', 'portal:x', 'workspace:*', 'github:a/b', 'git+https://example.invalid/x.git', 'https://example.invalid/x.tgz', 'npm:other@1', './x', '/opt/x']) expect(isRegistrySpec(spec)).toBe(false)
  })

  it('reads the content address an attachment path names', () => {
    const digest = 'ab'.padEnd(64, '0')
    expect(attachmentAddress(`attachments/v1/objects/ab/${digest}`)).toBe(digest)
    expect(attachmentAddress(`attachments/v1/file-objects/ab/${digest}`)).toBe(digest)
    expect(attachmentAddress(`attachments/v1/files/ab/${digest}/report.pdf`)).toBe(digest)
    for (const path of [`attachments/v2/objects/ab/${digest}`, `other/v1/objects/ab/${digest}`, `attachments/v1/files/ab/${digest}`, `attachments/v1/objects/ab/${digest}/x`, `attachments/v1/odd/ab/${digest}`, `attachments/v1/objects/cd/${digest}`, 'attachments/v1/objects/ab/abcd', 'attachments/v1/objects']) {
      expect(attachmentAddress(path)).toBeUndefined()
    }
  })
})

describe('the layer splitter', () => {
  it('names a row by its id, its first inserted plugin, or its position', () => {
    const split = splitPatchLayer('- insert:\n    - name: some-plugin\n- insert: []\n- insert:\n    - just-a-name\n- just a scalar\n- id: 7\n')
    expect(split.held.map(row => [row.label, row.reason, row.detail])).toEqual([
      ['insert some-plugin', 'code', undefined],
      ['row 2', 'code', undefined],
      ['row 3', 'code', undefined],
      ['row 4', 'not-understood', 'a field a row does not hold'],
      ['row 5', 'not-understood', 'a row without an id'],
    ])
    expect(split.carriedLabels).toEqual([])
  })

  it('holds back a row with a disabled flag or a field a row does not hold, and a row with no settings outside the list', () => {
    expect(splitPatchLayer('- id: ui-chat\n  disabled: false\n').held).toEqual([{ label: 'ui-chat', reason: 'not-understood', detail: 'disabled' }])
    expect(splitPatchLayer('- id: ui-chat\n  when: always\n').held).toEqual([{ label: 'ui-chat', reason: 'not-understood', detail: 'a field a row does not hold' }])
    expect(splitPatchLayer('- id: sandbox\n').held).toEqual([{ label: 'sandbox', reason: 'not-understood', detail: 'a row the import does not carry' }])
    expect(splitPatchLayer('- id: ui-chat\n').carriedLabels).toEqual(['ui-chat'])
    expect(splitPatchLayer('- id: ui-chat\n  config: just-text\n').held).toEqual([{ label: 'ui-chat', reason: 'not-understood', detail: '(its settings are not a map)' }])
  })

  it('carries only short plain values: booleans, finite numbers and strings without controls', () => {
    const value = (text: string): readonly string[] => splitPatchLayer(`- id: ui-theme\n  config:\n    textFontFamily: ${text}\n`).carriedLabels
    expect(value('Inter')).toEqual(['ui-theme'])
    expect(value('12')).toEqual(['ui-theme'])
    expect(value('true')).toEqual(['ui-theme'])
    expect(value('.inf')).toEqual([])
    expect(value('null')).toEqual([])
    expect(value(JSON.stringify('x'.repeat(201)))).toEqual([])
    expect(value('"a\\u001bb"')).toEqual([])
    expect(splitPatchLayer('- id: ui-chat\n  config:\n    customDisplay:\n      thinking: hidden\n      extra: 1\n').held).toEqual([{ label: 'ui-chat', reason: 'not-understood', detail: 'customDisplay.extra' }])
  })

  it('carries a font family only in letters, digits, spaces, commas, hyphens and quotes, because the studio writes it into its styles', () => {
    const family = (text: string): readonly string[] => splitPatchLayer(stringify([{ id: 'ui-theme', config: { codeFontFamily: text } }])).carriedLabels
    expect(family('Inter, "Fira Code", \'JetBrains Mono\', monospace')).toEqual(['ui-theme'])
    expect(family('')).toEqual(['ui-theme'])
    for (const text of ['Inter; } body { background: url(https://collector.invalid) }', 'a</style><script>', 'Inter\\', 'x/*y*/', 'Ünïcode', 'a'.repeat(101)]) {
      expect([text, family(text)]).toEqual([text, []])
    }
    expect(splitPatchLayer(stringify([{ id: 'ui-theme', config: { textFontFamily: 'a;b' } }])).held).toEqual([{ label: 'ui-theme', reason: 'not-understood', detail: 'textFontFamily' }])
    // A setting that is not written into styles keeps the general rule.
    expect(splitPatchLayer(stringify([{ id: 'agent-default-model', config: { model: 'deepseek/chat:v3.1' } }])).carriedLabels).toEqual(['agent-default-model'])
  })

  it('names a settings section without a string name as one it does not read, and holds an empty section', () => {
    const split = splitSettingsLayer('1: x\n? [a]\n: y\nempty:\nui-chat: !!js 1\n')
    expect(split.held.map(row => [row.label, row.reason])).toEqual([['1', 'not-understood'], ['(a section without a name)', 'not-understood'], ['empty', 'not-understood'], ['ui-chat', 'expression']])
    expect(split.carried).toBe('{}\n')
    expect(splitSettingsLayer('ui-chat: !custom x\n').held).toEqual([{ label: 'ui-chat', reason: 'not-understood', detail: 'a tag' }])
    expect(splitSettingsLayer('locale:\n  preference: en\n').heldText).toBeUndefined()
    expect(splitSettingsLayer('ui-chat:\n  linkOpening: [a]\n').held).toEqual([{ label: 'ui-chat', reason: 'not-understood', detail: 'linkOpening' }])
    expect(splitSettingsLayer('ui-chat: [a]\nlocale: dark\n? ui-theme\n').held.map(row => row.detail)).toEqual(['(its settings are not a map)', '(its settings are not a map)', '(its settings are not a map)'])
    expect(splitPatchLayer('').carried).toBe('[]\n')
    expect(splitSettingsLayer('# only a comment\n').carried).toBe('{}\n')
  })
})
