/**
 * The isolated browser's admission by workspace. The denial cases prove that a chat in a workspace that chose no browser,
 * or in a folder inside one, is not admitted, that a stored choice the store refuses admits no chat, and that a changed
 * choice applies to the next chat once `.setDefaults` has recorded it.
 */
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBrowserAdmission } from '../src/browser-admission.ts'
import { setDefaultsRoute } from '../src/defaults.ts'
import type { WorkspaceDefaults } from '../src/wire.ts'

let scratch = ''
let delorunHome = ''
let person = ''
let quiet = ''
let open = ''

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'delorun-new-workspace-browser-')))
  person = join(scratch, 'person')
  delorunHome = join(scratch, 'delorun')
  quiet = join(person, 'src', 'quiet')
  open = join(person, 'src', 'open')
  for (const directory of [join(quiet, 'docs'), open, join(person, '.dsh'), delorunHome]) await mkdir(directory, { recursive: true })
  vi.stubEnv('HOME', person)
  vi.stubEnv('DELORUN_HOME', delorunHome)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(scratch, { recursive: true, force: true })
})

/** The environment and log the admission needs. */
const deps = () => ({ env: process.env, warn: vi.fn() })

/**
 * A chat's Agent as the admission reads it.
 * @param cwd - the chat's folder.
 * @returns the Agent's session header.
 */
const chat = (cwd: string | undefined) => ({ session: { header: { cwd } } }) as Parameters<Awaited<ReturnType<typeof createBrowserAdmission>>['admitted']>[0]

/**
 * Record one workspace's defaults through the route, as the flow does.
 * @param path - the workspace's folder.
 * @param defaults - what to record.
 */
async function record(path: string, defaults: WorkspaceDefaults): Promise<void> {
  const response = await setDefaultsRoute(new Request('http://harness.test/api', { method: 'POST', body: JSON.stringify({ path, defaults }) }), deps())
  expect(response.status).toBe(200)
}

describe('the browser admission by workspace', () => {
  it('admits no chat in a workspace that chose no browser, nor in a folder inside it, and admits every other chat', async () => {
    await record(quiet, { browser: 'none' })
    await record(open, { browser: 'isolated' })
    const admission = await createBrowserAdmission(deps())
    expect(admission.admitted(chat(quiet))).toBe(false)
    expect(admission.admitted(chat(join(quiet, 'docs')))).toBe(false)
    expect(admission.admitted(chat(open))).toBe(true)
    expect(admission.admitted(chat(person))).toBe(true)
    expect(admission.admitted(chat(undefined))).toBe(true)
  })

  it('applies a changed choice to the next chat once it is recorded and read again', async () => {
    await record(quiet, { browser: 'isolated' })
    const admission = await createBrowserAdmission(deps())
    expect(admission.admitted(chat(quiet))).toBe(true)
    await record(quiet, { browser: 'none' })
    await admission.refresh()
    expect(admission.admitted(chat(quiet))).toBe(false)
    await record(quiet, { browser: 'isolated' })
    await admission.refresh()
    expect(admission.admitted(chat(quiet))).toBe(true)
  })

  it('admits no chat while a store that exists is refused, and says why without a path', async () => {
    const file = join(delorunHome, 'secrets', 'new-workspace', 'defaults.json')
    await mkdir(join(delorunHome, 'secrets', 'new-workspace'), { recursive: true })
    await writeFile(file, JSON.stringify({ v: 1, workspaces: {} }))
    await chmod(file, 0o644)
    const harness = deps()
    const admission = await createBrowserAdmission(harness)
    expect(admission.admitted(chat(open))).toBe(false)
    expect(harness.warn).toHaveBeenCalledOnce()
    expect(String(harness.warn.mock.calls[0]?.[0])).not.toContain(scratch)
  })

  it('admits every chat while no choice is stored', async () => {
    const admission = await createBrowserAdmission(deps())
    expect(admission.admitted(chat(quiet))).toBe(true)
  })
})
