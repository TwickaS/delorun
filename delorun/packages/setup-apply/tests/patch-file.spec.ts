import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { readPatchRow, setPatchRow, setRowFields, type InheritedRow } from '../src/patch-file.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'delorun-patch-file-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('the profile patch', () => {
  it('merges config keys into an existing row and keeps the others', () => {
    const path = join(directory, 'cordis.patch.yml')
    writeFileSync(path, '- id: webserver\n  config:\n    host: 127.0.0.1\n- id: other\n')
    setPatchRow(path, { id: 'webserver', config: { port: 4000 } })
    setPatchRow(path, { id: 'fresh', config: { enabled: true } })
    expect(parse(readFileSync(path, 'utf8'))).toEqual([{ id: 'webserver', config: { host: '127.0.0.1', port: 4000 } }, { id: 'other' }, { id: 'fresh', config: { enabled: true } }])
    writeFileSync(path, '- id: bare\n')
    setPatchRow(path, { id: 'bare', config: { enabled: false } })
    expect(parse(readFileSync(path, 'utf8'))).toEqual([{ id: 'bare', config: { enabled: false } }])
  })

  it('leaves a file that is not a patch list unchanged', () => {
    const path = join(directory, 'cordis.patch.yml')
    writeFileSync(path, 'not: a list\n')
    expect(() => setPatchRow(path, { id: 'a', config: { enabled: true } })).toThrow('is not a patch list')
    writeFileSync(path, '- [unclosed\n')
    expect(() => setPatchRow(path, { id: 'a', config: { enabled: true } })).toThrow('delorun setup: ' + path + ' is not a YAML patch list delorun can read; it was not changed')
    expect(readFileSync(path, 'utf8')).toBe('- [unclosed\n')
    writeFileSync(path, '')
    setPatchRow(path, { id: 'a', config: { enabled: true } })
    expect(parse(readFileSync(path, 'utf8'))).toEqual([{ id: 'a', config: { enabled: true } }])
    rmSync(path)
    setPatchRow(path, { id: 'b', config: { enabled: false } })
    expect(parse(readFileSync(path, 'utf8'))).toEqual([{ id: 'b', config: { enabled: false } }])
  })
})

describe('reading the profile patch', () => {
  it('reads the config of one row, and none for an absent file, row or config', () => {
    const path = join(directory, 'cordis.patch.yml')
    expect(readPatchRow(path, 'webserver', 'delorun doctor')).toBeUndefined()
    writeFileSync(path, '- id: webserver\n  config:\n    port: 4100\n- id: bare\n- plain text row\n')
    expect(readPatchRow(path, 'webserver', 'delorun doctor')).toEqual({ port: 4100 })
    expect(readPatchRow(path, 'bare', 'delorun doctor')).toBeUndefined()
    expect(readPatchRow(path, 'missing', 'delorun doctor')).toBeUndefined()
  })

  it('refuses a file that is not a patch list, with the command\'s name', () => {
    const path = join(directory, 'cordis.patch.yml')
    writeFileSync(path, 'not: a list\n')
    expect(() => readPatchRow(path, 'webserver', 'delorun doctor')).toThrow(`delorun doctor: ${path} is not a patch list`)
    writeFileSync(path, '- [unclosed\n')
    expect(() => readPatchRow(path, 'webserver', 'delorun doctor')).toThrow(`delorun doctor: ${path} is not a YAML patch list delorun can read`)
  })
})

describe('a bundle row in the settings service\'s form', () => {
  const INHERITED: InheritedRow = { id: 'checked', name: '@bundle/checked', config: { enabled: true, intervalHours: 24 } }

  it('restates the inherited config with the field changed, and keeps a field the profile row already set', () => {
    const path = join(directory, 'cordis.patch.yml')
    setRowFields(path, INHERITED, { enabled: false })
    expect(readFileSync(path, 'utf8')).toBe('- id: checked\n  name: "@bundle/checked"\n  config:\n    intervalHours: 24\n    enabled: false\n')
    writeFileSync(path, '- id: checked\n  config:\n    intervalHours: 48\n    enabled: true\n- id: other\n')
    setRowFields(path, INHERITED, { enabled: false })
    expect(parse(readFileSync(path, 'utf8'))).toEqual([{ id: 'checked', config: { intervalHours: 48, enabled: false } }, { id: 'other' }])
  })

  it('leaves no config when the result equals the inherited one, keeping a row that sets other keys and every row it does not target', () => {
    const path = join(directory, 'cordis.patch.yml')
    writeFileSync(path, [
      '- id: checked\n  disabled: false\n  config:\n    enabled: false',
      '- id: checked\n  name: "@bundle/checked"\n  config:\n    intervalHours: 24\n    enabled: false',
      '- id: checked\n  name: "@elsewhere/checked"\n  config:\n    enabled: false',
      '- insert:\n    - id: checked\n      name: "@bundle/checked"',
      '- other',
      '',
    ].join('\n'))
    setRowFields(path, INHERITED, { enabled: true })
    expect(parse(readFileSync(path, 'utf8'))).toEqual([
      { id: 'checked', disabled: false },
      { id: 'checked', name: '@elsewhere/checked', config: { enabled: false } },
      { insert: [{ id: 'checked', name: '@bundle/checked' }] },
      'other',
    ])
  })
})
