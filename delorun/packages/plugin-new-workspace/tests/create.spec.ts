/**
 * The route that makes a new folder: it holds the destination against the roots and the locations Delorun never adds
 * before it makes anything, starts Git with hardened settings and an empty template only when asked, adds the folder as a
 * workspace, and removes the folder it made when the registry refuses it.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cloneEnvironment, HARDENED_CONFIG, spawnGit, type GitOutcome, type GitRunner } from '../src/clone.ts'
import { createWorkspace, STARTER_GITIGNORE } from '../src/create.ts'
import { CreateAnswer, MAX_BODY_BYTES } from '../src/wire.ts'

let scratch = ''
let person = ''
let delorunHome = ''

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'delorun-new-workspace-create-'))
  person = join(scratch, 'a', 'b', 'person')
  delorunHome = join(scratch, 'delorun')
  for (const directory of [join(person, 'projects'), join(person, '.dsh'), join(delorunHome, 'inside')]) await mkdir(directory, { recursive: true })
  vi.stubEnv('HOME', person)
  vi.stubEnv('DELORUN_HOME', delorunHome)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(scratch, { recursive: true, force: true })
})

/** Whether a path exists. */
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

/** A Git that records each run and answers as `outcome` says (success by default). */
function gitFake(outcome: GitOutcome | ((signal: AbortSignal) => Promise<GitOutcome>) = { kind: 'exited', code: 0, stderr: '' }) {
  const runs: { readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly template: boolean }[] = []
  const git: GitRunner = async (args, env, signal) => {
    const template = args.find(each => each.startsWith('--template='))
    runs.push({ args, env, template: template !== undefined && await exists(template.slice('--template='.length)) })
    return typeof outcome === 'function' ? outcome(signal) : outcome
  }
  return { git, runs }
}

/** Create over a Git, roots and a registry fake, with the stubbed environment. */
function setup(options: { readonly git?: GitRunner; readonly roots?: readonly string[]; readonly create?: (path: string) => Promise<{ id: string; path: string }>; readonly timeoutMs?: number } = {}) {
  const create = vi.fn(options.create ?? (async (path: string) => ({ id: 'workspace-3', path })))
  const git = vi.fn(options.git ?? gitFake().git)
  const remember = vi.fn(async (_parent: string) => undefined)
  const warn = vi.fn()
  const run = async (body: unknown) => {
    const response = await createWorkspace(
      new Request('http://harness.test/api', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }),
      { roots: options.roots ?? ['~'], git, timeoutMs: options.timeoutMs ?? 60_000, remember, registry: { create } as never, env: process.env, warn },
    )
    const answer: unknown = await response.json()
    return { status: response.status, body: answer }
  }
  return { run, create, git, remember, warn }
}

describe('making a new folder', () => {
  it('makes the folder, adds it as a workspace and answers its id and folder', async () => {
    const parent = join(person, 'projects')
    const { run, create, git, remember } = setup()
    const answer = await run({ parent, name: 'fresh', git: false })
    expect(answer.status).toBe(200)
    expect(CreateAnswer.parse(answer.body)).toEqual({ result: 'added', workspaceId: 'workspace-3', path: join(parent, 'fresh'), git: false })
    expect(await readdir(join(parent, 'fresh'))).toEqual([])
    expect(create).toHaveBeenCalledExactlyOnceWith(join(parent, 'fresh'))
    expect(git).not.toHaveBeenCalled()
    expect(remember).toHaveBeenCalledExactlyOnceWith(parent)
  })

  it('creates a parent folder that is missing', async () => {
    const parent = join(person, 'projects', 'not', 'yet')
    const { run } = setup()
    expect((await run({ parent, name: 'fresh', git: false })).status).toBe(200)
    expect((await stat(join(parent, 'fresh'))).isDirectory()).toBe(true)
  })

  it('takes a destination inside an absolute root', async () => {
    const root = join(scratch, 'other-root')
    await mkdir(root)
    const { run } = setup({ roots: [root] })
    expect((await run({ parent: join(root, 'p'), name: 'fresh', git: false })).status).toBe(200)
  })
})

describe('starting Git in the new folder', () => {
  it('runs git init with the hardened configuration and an empty template, then writes the starter .gitignore', async () => {
    const parent = join(person, 'projects')
    const fake = gitFake()
    const { run } = setup({ git: fake.git })
    const answer = await run({ parent, name: 'repo', git: true })
    expect(CreateAnswer.parse(answer.body)).toMatchObject({ result: 'added', git: true })
    const folder = join(parent, 'repo')
    expect(fake.runs).toHaveLength(1)
    const args = fake.runs[0]?.args ?? []
    expect(args.slice(0, HARDENED_CONFIG.length)).toEqual(HARDENED_CONFIG)
    expect(args.slice(HARDENED_CONFIG.length, HARDENED_CONFIG.length + 2)).toEqual(['init', '--quiet'])
    expect(args[HARDENED_CONFIG.length + 2]).toMatch(/^--template=/u)
    expect(args.slice(-2)).toEqual(['--', folder])
    expect(fake.runs[0]?.env).toEqual(cloneEnvironment(process.env))
    expect(fake.runs[0]?.template).toBe(true)
    expect(await readFile(join(folder, '.gitignore'), 'utf8')).toBe(STARTER_GITIGNORE)
    expect(await exists((args[HARDENED_CONFIG.length + 2] as string).slice('--template='.length))).toBe(false)
  })

  it('adds the folder without Git, and says so, when Git is not installed', async () => {
    const { run, warn } = setup({ git: gitFake({ kind: 'missing' }).git })
    const answer = await run({ parent: join(person, 'projects'), name: 'repo', git: true })
    expect(CreateAnswer.parse(answer.body)).toMatchObject({ result: 'added', git: false })
    expect(await readdir(join(person, 'projects', 'repo'))).toEqual([])
    expect(warn).toHaveBeenCalledExactlyOnceWith('git init did not start a repository: no-git')
  })

  it('adds the folder without Git when git init fails', async () => {
    const { run, warn } = setup({ git: gitFake({ kind: 'exited', code: 1, stderr: 'fatal' }).git })
    expect(CreateAnswer.parse((await run({ parent: join(person, 'projects'), name: 'repo', git: true })).body)).toMatchObject({ result: 'added', git: false })
    expect(warn).toHaveBeenCalledExactlyOnceWith('git init did not start a repository: failed')
  })

  it('adds the folder without Git when git init outlasts its time', async () => {
    const waiting = gitFake(signal => new Promise((resolve) => { signal.addEventListener('abort', () => { resolve({ kind: 'exited', code: null, stderr: '' }) }) }))
    const { run, warn } = setup({ git: waiting.git, timeoutMs: 10 })
    expect(CreateAnswer.parse((await run({ parent: join(person, 'projects'), name: 'repo', git: true })).body)).toMatchObject({ result: 'added', git: false })
    expect(warn).toHaveBeenCalledExactlyOnceWith('git init did not start a repository: timeout')
  })

  it('adds the folder without Git, naming only the error, when the run itself stops unexpectedly', async () => {
    const { run, warn } = setup({ git: () => Promise.reject(new TypeError('/secret/path')) })
    expect(CreateAnswer.parse((await run({ parent: join(person, 'projects'), name: 'repo', git: true })).body)).toMatchObject({ result: 'added', git: false })
    expect(warn).toHaveBeenCalledExactlyOnceWith('git init stopped unexpectedly: TypeError')
  })
})

describe('refusing a new folder', () => {
  it.each(['..', 'a/b', '-x', '.', ' padded'])('refuses the name %j and makes nothing', async (name) => {
    const { run, create, git } = setup()
    const answer = await run({ parent: join(person, 'projects'), name, git: true })
    expect(answer).toEqual({ status: 422, body: { result: 'refused', problem: 'name-form' } })
    expect(await readdir(join(person, 'projects'))).toEqual([])
    expect([create.mock.calls.length, git.mock.calls.length]).toEqual([0, 0])
  })

  it('refuses a parent that is not absolute', async () => {
    const { run, create } = setup()
    expect(await run({ parent: 'projects', name: 'x', git: false })).toEqual({ status: 422, body: { result: 'refused', problem: 'not-absolute' } })
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses a name that is already there, whatever it is, and leaves it as it was', async () => {
    const parent = join(person, 'projects')
    await mkdir(join(parent, 'used'))
    await writeFile(join(parent, 'used', 'keep.txt'), 'kept')
    await writeFile(join(parent, 'file'), 'kept')
    const { run, create, remember } = setup()
    for (const name of ['used', 'file']) expect(await run({ parent, name, git: false })).toEqual({ status: 422, body: { result: 'refused', problem: 'exists' } })
    expect(await readFile(join(parent, 'used', 'keep.txt'), 'utf8')).toBe('kept')
    expect(await readFile(join(parent, 'file'), 'utf8')).toBe('kept')
    expect([create.mock.calls.length, remember.mock.calls.length]).toEqual([0, 0])
  })

  it('refuses the home directory itself as the destination', async () => {
    const { run, create } = setup()
    expect(await run({ parent: join(scratch, 'a', 'b'), name: 'person', git: false })).toEqual({ status: 422, body: { result: 'refused', problem: 'home-directory' } })
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses a destination inside the Delorun home and makes nothing there', async () => {
    const { run, create, git, remember } = setup()
    expect(await run({ parent: delorunHome, name: 'new', git: true })).toEqual({ status: 422, body: { result: 'refused', problem: 'delorun-home' } })
    expect(await readdir(delorunHome)).toEqual(['inside'])
    expect([create.mock.calls.length, git.mock.calls.length, remember.mock.calls.length]).toEqual([0, 0, 0])
  })

  it('refuses a destination outside the roots and makes neither the folder nor its parent', async () => {
    const parent = join(scratch, 'elsewhere')
    const { run, create, git, remember } = setup()
    expect(await run({ parent, name: 'new', git: true })).toEqual({ status: 422, body: { result: 'refused', problem: 'outside-roots' } })
    expect(await exists(parent)).toBe(false)
    expect([create.mock.calls.length, git.mock.calls.length, remember.mock.calls.length]).toEqual([0, 0, 0])
  })

  it('refuses a destination reached through a link inside the root that leaves it, and makes nothing there', async () => {
    const outside = join(scratch, 'outside')
    await mkdir(outside)
    await symlink(outside, join(person, 'projects', 'out'))
    const { run, create } = setup()
    for (const parent of [join(person, 'projects', 'out'), join(person, 'projects', 'out', 'sub')]) {
      expect(await run({ parent, name: 'new', git: false })).toEqual({ status: 422, body: { result: 'refused', problem: 'outside-roots' } })
    }
    expect(await readdir(outside)).toEqual([])
    expect(create).not.toHaveBeenCalled()
  })

  it('answers 500 and makes nothing when the Delorun home cannot be resolved', async () => {
    vi.stubEnv('DELORUN_HOME', 'relative/home')
    const { run, create, remember } = setup()
    expect(await run({ parent: join(person, 'projects'), name: 'new', git: false })).toEqual({ status: 500, body: { result: 'failed' } })
    expect(await readdir(join(person, 'projects'))).toEqual([])
    expect([create.mock.calls.length, remember.mock.calls.length]).toEqual([0, 0])
  })

  it('answers 500 when the folder cannot be made, without naming the path', async () => {
    const parent = join(person, 'projects')
    await writeFile(join(parent, 'blocker'), 'a file')
    const { run, warn } = setup()
    // `blocker` is a file, so the folder under it cannot be made.
    const answer = await run({ parent: join(parent, 'blocker'), name: 'new', git: false })
    expect(answer.status).toBe(500)
    expect(answer.body).toEqual({ result: 'failed' })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(parent)
  })
})

describe('when the registry refuses the new folder', () => {
  it('answers 500, removes the folder it made, and remembers nothing', async () => {
    const parent = join(person, 'projects')
    const { run, remember, warn } = setup({ git: gitFake().git, create: () => Promise.reject(Object.assign(new Error(`${parent}/repo`), { code: 'EEXIST' })) })
    expect(await run({ parent, name: 'repo', git: true })).toEqual({ status: 500, body: { result: 'failed' } })
    expect(await exists(join(parent, 'repo'))).toBe(false)
    expect(await exists(parent)).toBe(true)
    expect(remember).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('the folder could not be added as a workspace: EEXIST')
  })
})

describe('reading the request', () => {
  it.each([
    ['not JSON', '{'],
    ['a missing git field', { parent: '/x', name: 'x' }],
    ['an extra field', { parent: '/x', name: 'x', git: false, template: '/y' }],
    ['an empty name', { parent: '/x', name: '', git: false }],
    ['a body over the largest body', { parent: '/x', name: 'x', git: false, pad: ' '.repeat(MAX_BODY_BYTES) }],
  ])('answers 400 to %s and makes nothing', async (_, body) => {
    const { run, create, git } = setup()
    expect((await run(body)).status).toBe(400)
    expect([create.mock.calls.length, git.mock.calls.length]).toEqual([0, 0])
  })
})

describe('real Git', () => {
  it('starts a repository with the starter .gitignore and copies nothing from the person\'s own template', async () => {
    const template = join(scratch, 'person-template')
    await mkdir(join(template, 'hooks'), { recursive: true })
    await writeFile(join(template, 'hooks', 'post-checkout'), '#!/bin/sh\n', { mode: 0o755 })
    await writeFile(join(person, '.gitconfig'), `[init]\n\ttemplateDir = ${template}\n`)
    const abort = new AbortController()
    const deadline = setTimeout(() => { abort.abort() }, 20_000)
    onTestFinished(() => { clearTimeout(deadline) })
    const { run } = setup({ git: (args, env, _signal, onStderr) => spawnGit(args, env, abort.signal, onStderr) })
    const answer = await run({ parent: join(person, 'projects'), name: 'repo', git: true })
    expect(CreateAnswer.parse(answer.body)).toMatchObject({ result: 'added', git: true })
    const folder = join(person, 'projects', 'repo')
    expect(await exists(join(folder, '.git', 'HEAD'))).toBe(true)
    expect(await exists(join(folder, '.git', 'hooks', 'post-checkout'))).toBe(false)
    expect(await readFile(join(folder, '.gitignore'), 'utf8')).toBe(STARTER_GITIGNORE)
  }, 30_000)
})
