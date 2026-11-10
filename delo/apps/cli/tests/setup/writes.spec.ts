import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { CliError } from '../../src/exit.ts'
import { setPatchRow, storeCredential } from '../../src/setup/writes.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'delorun-writes-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('the credentials document', () => {
  it('merges a reference into the document that is there, keeping the others', () => {
    writeFileSync(join(directory, '.credentials.yaml'), 'version: 1\nrefs:\n  OTHER: kept\n')
    storeCredential(directory, 'DEEPSEEK_API_KEY', 'stored-value')
    expect(parse(readFileSync(join(directory, '.credentials.yaml'), 'utf8'))).toEqual({ version: 1, refs: { OTHER: 'kept', DEEPSEEK_API_KEY: 'stored-value' } })
  })

  it('leaves a document upstream cannot read unchanged and does not echo the value', () => {
    writeFileSync(join(directory, '.credentials.yaml'), 'refs: {}\n')
    expect(() => storeCredential(directory, 'DEEPSEEK_API_KEY', 'stored-value')).toThrow(CliError)
    expect(readFileSync(join(directory, '.credentials.yaml'), 'utf8')).toBe('refs: {}\n')
    writeFileSync(join(directory, '.credentials.yaml'), 'a: [unclosed\n')
    expect(() => storeCredential(directory, 'DEEPSEEK_API_KEY', 'stored-value')).toThrow('is not a credentials document upstream reads')
  })
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
    expect(() => setPatchRow(path, { id: 'a', config: { enabled: true } })).toThrow('is not a YAML patch list setup can read')
    expect(readFileSync(path, 'utf8')).toBe('- [unclosed\n')
    writeFileSync(path, '')
    setPatchRow(path, { id: 'a', config: { enabled: true } })
    expect(parse(readFileSync(path, 'utf8'))).toEqual([{ id: 'a', config: { enabled: true } }])
    rmSync(path)
    setPatchRow(path, { id: 'b', config: { enabled: false } })
    expect(parse(readFileSync(path, 'utf8'))).toEqual([{ id: 'b', config: { enabled: false } }])
  })
})
