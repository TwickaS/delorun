/** The `workspaces` line of `delorun doctor`: it reads the registry file and changes nothing. */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkWorkspaces } from '../../src/doctor/workspaces.ts'
import { describeRegistry, readRegistryStore } from '../../src/workspace-store.ts'

const record = { path: '/p', title: 't', sessionIds: [], createdAt: 'x', updatedAt: 'x' }
const registry = (workspaces: Record<string, unknown>, order: string[]): string =>
  JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: order }, tables: { workspaces } })

let home: string
let file: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'doctor-workspaces-'))
  mkdirSync(join(home, 'storages'))
  file = join(home, 'storages', 'workspace.json')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('the workspaces line', () => {
  it('passes without a registry file and with a consistent one', async () => {
    expect(await checkWorkspaces(home)).toEqual({ name: 'workspaces', status: 'pass', message: 'no workspace registry file exists yet.' })
    writeFileSync(file, registry({ a: record }, ['a']))
    expect(await checkWorkspaces(home)).toEqual({ name: 'workspaces', status: 'pass', message: 'the workspace registry holds 1 workspace.' })
  })

  it('passes when the storages directory does not exist yet', async () => {
    rmSync(join(home, 'storages'), { recursive: true })
    expect(await checkWorkspaces(home)).toMatchObject({ status: 'pass' })
  })

  it('fails on an unreadable file and names the fix when a previous copy exists', async () => {
    writeFileSync(file, '{ broken')
    const without = await checkWorkspaces(home)
    expect(without).toMatchObject({ name: 'workspaces', status: 'fail' })
    expect(without.message).toContain('does not read')
    expect(without.message).toContain('No previous copy exists.')
    writeFileSync(`${file}.previous`, registry({ a: record }, ['a']))
    const result = await checkWorkspaces(home)
    expect(result.message).toContain('A previous copy exists; delorun recover workspaces restores the previous good copy after asking.')
  })

  it('warns and names each damaged record', async () => {
    writeFileSync(file, registry({ a: record, b: { ...record, path: '/q' } }, ['a', 'ghost']))
    const result = await checkWorkspaces(home)
    expect(result.status).toBe('warn')
    expect(result.message).toContain("references missing workspace 'ghost'")
    expect(result.message).toContain("workspace 'b' is absent from registry order")
  })

  it('warns about earlier set-aside files and lists them, even for a clean registry', async () => {
    writeFileSync(file, registry({ a: record }, ['a']))
    writeFileSync(`${file}.quarantined-2026-11-14T10-00-00-000Z.json`, '{}')
    const result = await checkWorkspaces(home)
    expect(result.status).toBe('warn')
    expect(result.message).toContain('workspace.json.quarantined-2026-11-14T10-00-00-000Z.json')
    rmSync(file)
    expect(await checkWorkspaces(home)).toMatchObject({ status: 'warn' })
  })

  it('reads without writing', async () => {
    writeFileSync(file, '{ broken')
    const before = readdirSync(join(home, 'storages'))
    await checkWorkspaces(home)
    expect(readdirSync(join(home, 'storages'))).toEqual(before)
  })

  it('surfaces a read error that is not a missing file', async () => {
    mkdirSync(file)
    await expect(readRegistryStore(home)).rejects.toMatchObject({ code: 'EISDIR' })
    rmSync(file, { recursive: true })
    writeFileSync(join(home, 'storages-file'), 'x')
    await expect(readRegistryStore(join(home, 'storages-file'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    expect(describeRegistry({ path: file, inspection: undefined })).toBe('no file')
  })
})
