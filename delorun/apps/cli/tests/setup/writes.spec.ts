import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { CliError } from '../../src/exit.ts'
import { readPatchRow, setPatchRow, STUDIO_ROW_ID } from '@delorun/setup-apply'
import { profileStudioPort } from '../../src/setup/sections.ts'
import { storeCredential } from '../../src/setup/writes.ts'

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

describe('the studio port a profile sets', () => {
  it('reads back the port the profile section writes, and none when the profile sets none', () => {
    expect(profileStudioPort(directory, 'delorun doctor')).toBeUndefined()
    const path = join(directory, 'cordis.patch.yml')
    setPatchRow(path, { id: STUDIO_ROW_ID, config: { host: '127.0.0.1', port: 4100 } })
    expect(profileStudioPort(directory, 'delorun doctor')).toBe(4100)
    writeFileSync(path, `- id: ${STUDIO_ROW_ID}\n  config:\n    host: 127.0.0.1\n`)
    expect(profileStudioPort(directory, 'delorun doctor')).toBeUndefined()
  })

  it('reads port 0, which asks the system for a free port at each start, and a `!!js` expression beside it without a warning', () => {
    const path = join(directory, 'cordis.patch.yml')
    writeFileSync(path, `- id: ${STUDIO_ROW_ID}\n  config:\n    host: !!js ctx.webStartup.host\n    port: 0\n`)
    expect(profileStudioPort(directory, 'delorun doctor')).toBe(0)
    expect(readPatchRow(path, STUDIO_ROW_ID, 'delorun doctor')).toEqual({ host: 'ctx.webStartup.host', port: 0 })
  })

  it.each([['a text', '"4100"'], ['a fraction', '4100.5'], ['a negative number', '-1'], ['a port above 65535', '65536'], ['null', 'null']])('refuses %s as the port, naming the row and the file', (_label, value) => {
    const path = join(directory, 'cordis.patch.yml')
    writeFileSync(path, `- id: ${STUDIO_ROW_ID}\n  config:\n    port: ${value}\n`)
    expect(() => profileStudioPort(directory, 'delorun doctor')).toThrow(`delorun doctor: the ${STUDIO_ROW_ID} row of ${path} sets port to `)
  })
})
