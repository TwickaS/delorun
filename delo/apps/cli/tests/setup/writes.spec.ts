import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { CliError } from '../../src/exit.ts'
import { profileStudioPort, STUDIO_ROW_ID } from '../../src/setup/sections.ts'
import { readPatchRow, setPatchRow, setRowFields, storeCredential, type InheritedRow } from '../../src/setup/writes.ts'

// The protected-file writer's rename, replaceable per test to stop a write at the moment before the rename.
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'delorun-writes-'))
})

afterEach(() => {
  vi.mocked(fsPromises.rename).mockReset()
  rmSync(directory, { recursive: true, force: true })
})

describe('the credentials document', () => {
  const credentials = (): string => join(directory, '.credentials.yaml')

  it('merges a reference into the document that is there, keeping the others', async () => {
    writeFileSync(credentials(), 'version: 1\nrefs:\n  OTHER: kept\n')
    await storeCredential(directory, 'DEEPSEEK_API_KEY', 'stored-value')
    expect(parse(readFileSync(credentials(), 'utf8'))).toEqual({ version: 1, refs: { OTHER: 'kept', DEEPSEEK_API_KEY: 'stored-value' } })
  })

  it('leaves a document upstream cannot read unchanged and does not echo the value', async () => {
    writeFileSync(credentials(), 'refs: {}\n')
    await expect(storeCredential(directory, 'DEEPSEEK_API_KEY', 'stored-value')).rejects.toThrow(CliError)
    expect(readFileSync(credentials(), 'utf8')).toBe('refs: {}\n')
    writeFileSync(credentials(), 'a: [unclosed\n')
    await expect(storeCredential(directory, 'DEEPSEEK_API_KEY', 'stored-value')).rejects.toThrow('is not a credentials document upstream reads')
    // The refusal released the writer lock.
    expect(readdirSync(directory).sort()).toEqual(['.credentials.yaml'])
  })

  it.skipIf(process.platform === 'win32')('replaces a document of a wider mode with one at 0600', async () => {
    writeFileSync(credentials(), 'version: 1\nrefs: {}\n', { mode: 0o644 })
    await storeCredential(directory, 'DEEPSEEK_API_KEY', 'stored-value')
    expect(statSync(credentials()).mode & 0o777).toBe(0o600)
    expect(readdirSync(directory).sort()).toEqual(['.credentials.yaml'])
  })

  it.skipIf(process.platform === 'win32')('never writes the key into a left-over temporary file of a wider mode', async () => {
    const leftOver = `${credentials()}.tmp`
    writeFileSync(leftOver, 'left over\n', { mode: 0o644 })
    await storeCredential(directory, 'DEEPSEEK_API_KEY', 'stored-value')
    expect(readFileSync(leftOver, 'utf8')).toBe('left over\n')
    expect(statSync(credentials()).mode & 0o777).toBe(0o600)
    expect(parse(readFileSync(credentials(), 'utf8'))).toEqual({ version: 1, refs: { DEEPSEEK_API_KEY: 'stored-value' } })
  })

  it.skipIf(process.platform === 'win32')('never writes the key through a temporary path planted as a symbolic link', async () => {
    const target = join(directory, 'elsewhere')
    writeFileSync(target, 'untouched\n', { mode: 0o644 })
    symlinkSync(target, `${credentials()}.tmp`)
    await storeCredential(directory, 'DEEPSEEK_API_KEY', 'stored-value')
    expect(readFileSync(target, 'utf8')).toBe('untouched\n')
    expect(lstatSync(`${credentials()}.tmp`).isSymbolicLink()).toBe(true)
    expect(lstatSync(credentials()).isFile()).toBe(true)
    expect(statSync(credentials()).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('leaves the document as it was and the key readable only by its owner when the write stops before the rename', async () => {
    writeFileSync(credentials(), 'version: 1\nrefs:\n  OTHER: kept\n', { mode: 0o600 })
    let stopped!: () => void
    const atRename = new Promise<void>((resolve) => { stopped = resolve })
    // The process stops here: the rename never happens.
    vi.mocked(fsPromises.rename).mockImplementationOnce(() => {
      stopped()
      return new Promise<void>(() => undefined)
    })
    void storeCredential(directory, 'DEEPSEEK_API_KEY', 'stored-value')
    await atRename
    expect(parse(readFileSync(credentials(), 'utf8'))).toEqual({ version: 1, refs: { OTHER: 'kept' } })
    const pending = readdirSync(directory).filter(name => name !== '.credentials.yaml' && name !== '.credentials.yaml.lock')
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatch(/^\.\.credentials\.yaml\.tmp-[0-9a-f]{16}$/)
    // The whole document was flushed before the rename, and only the owner can read it.
    expect(statSync(join(directory, pending[0]!)).mode & 0o777).toBe(0o600)
    expect(parse(readFileSync(join(directory, pending[0]!), 'utf8'))).toEqual({ version: 1, refs: { OTHER: 'kept', DEEPSEEK_API_KEY: 'stored-value' } })
  })

  it('reads and replaces the document under the writer lock the Host takes for it, so a concurrent change is kept', async () => {
    let entered!: () => void
    const inside = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    const holder = withFileLock(credentials(), async () => {
      entered()
      await released
      writeFileSync(credentials(), 'version: 1\nrefs:\n  OTHER: kept\n', { mode: 0o600 })
    })
    await inside
    const storing = storeCredential(directory, 'DEEPSEEK_API_KEY', 'stored-value')
    release()
    await Promise.all([holder, storing])
    expect(parse(readFileSync(credentials(), 'utf8'))).toEqual({ version: 1, refs: { OTHER: 'kept', DEEPSEEK_API_KEY: 'stored-value' } })
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

describe('the studio port a profile sets', () => {
  it('reads back the port the profile section writes, and none when the profile sets none', () => {
    expect(profileStudioPort(directory, 'delorun doctor')).toBeUndefined()
    const path = join(directory, 'cordis.patch.yml')
    setPatchRow(path, { id: STUDIO_ROW_ID, config: { host: '127.0.0.1', port: 4100 } })
    expect(profileStudioPort(directory, 'delorun doctor')).toBe(4100)
    writeFileSync(path, `- id: ${STUDIO_ROW_ID}\n  config:\n    host: 127.0.0.1\n`)
    expect(profileStudioPort(directory, 'delorun doctor')).toBeUndefined()
  })

  it('reads port 0, which asks the system for a free port at each start', () => {
    const path = join(directory, 'cordis.patch.yml')
    writeFileSync(path, `- id: ${STUDIO_ROW_ID}\n  config:\n    port: 0\n`)
    expect(profileStudioPort(directory, 'delorun doctor')).toBe(0)
  })

  it.each([['a text', '"4100"'], ['a fraction', '4100.5'], ['a negative number', '-1'], ['a port above 65535', '65536'], ['null', 'null']])('refuses %s as the port, naming the row and the file', (_label, value) => {
    const path = join(directory, 'cordis.patch.yml')
    writeFileSync(path, `- id: ${STUDIO_ROW_ID}\n  config:\n    port: ${value}\n`)
    expect(() => profileStudioPort(directory, 'delorun doctor')).toThrow(`delorun doctor: the ${STUDIO_ROW_ID} row of ${path} sets port to `)
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
