/**
 * The clone routes: they take only HTTPS and SSH addresses and one plain folder name, refuse every folder Delo never
 * adds and every folder that holds something before Git runs, never ask for a sign-in, and remove only what a failed
 * clone created.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cloneEnvironment, createCloneService, failureOf, spawnGit, type GitOutcome, type GitRunner } from '../src/clone.ts'
import { isCloneAddress, isFolderName, suggestedName } from '../src/clone-address.ts'
import { CloneStart, CloneStatus, MAX_CLONE_BODY_BYTES } from '../src/wire.ts'

let scratch = ''
let person = ''
let deloHome = ''

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'delo-onboarding-clone-'))
  person = join(scratch, 'a', 'b', 'person')
  deloHome = join(scratch, 'delo')
  for (const directory of [join(person, 'projects'), join(person, '.dsh'), join(deloHome, 'inside')]) await mkdir(directory, { recursive: true })
  vi.stubEnv('HOME', person)
  vi.stubEnv('DELO_HOME', deloHome)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(scratch, { recursive: true, force: true })
})

/** A Git that records each run and does what `act` says: by default it creates the folder and succeeds. */
function gitFake(act?: (args: readonly string[], signal: AbortSignal, onStderr: (text: string) => void) => Promise<GitOutcome>) {
  const runs: { readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> }[] = []
  const git: GitRunner = async (args, env, signal, onStderr) => {
    runs.push({ args, env })
    if (act !== undefined) return act(args, signal, onStderr)
    await mkdir(args.at(-1) as string, { recursive: true })
    return { kind: 'exited', code: 0, stderr: '' }
  }
  return { git, runs }
}

/** A Git run that waits for the test to finish it. */
function heldGit() {
  let finish: (outcome: GitOutcome) => void = () => {}
  const held = gitFake((_args, signal) => new Promise((resolve) => {
    finish = resolve
    signal.addEventListener('abort', () => { resolve({ kind: 'exited', code: null, stderr: '' }) })
  }))
  return { ...held, finish: (outcome: GitOutcome) => { finish(outcome) } }
}

/** The service over a Git, a registry fake and the stubbed environment. */
function service(git: GitRunner, options: { readonly timeoutMs?: number; readonly create?: (path: string) => Promise<{ id: string }> } = {}) {
  const create = vi.fn(options.create ?? (async (_path: string) => ({ id: 'workspace-9' })))
  const warn = vi.fn()
  const clones = createCloneService({ git, timeoutMs: options.timeoutMs ?? 60_000, registry: { create } as never, env: process.env, warn })
  onTestFinished(() => { clones.dispose() })
  const post = (body: unknown) => new Request('http://harness.test/api', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
  const start = async (body: unknown) => {
    const response = await clones.start(post(body))
    const answer: unknown = await response.json()
    return { status: response.status, body: answer }
  }
  const status = async (job: string): Promise<CloneStatus> => CloneStatus.parse(await (await clones.status(post({ job }))).json())
  /** Ask about a job until it is no longer running. */
  const settled = async (job: string): Promise<CloneStatus> => {
    for (let n = 0; n < 200; n++) {
      const now = await status(job)
      if (now.state !== 'running') return now
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('the clone never settled')
  }
  const started = async (body: unknown): Promise<string> => {
    const answer = CloneStart.parse((await start(body)).body)
    if (answer.result !== 'started') throw new Error(`refused: ${answer.problem}`)
    return answer.job
  }
  return { clones, create, warn, start, status, settled, started }
}

const REPO = 'https://github.com/owner/site.git'

describe('the repository addresses and folder names a clone takes', () => {
  it.each([
    'https://github.com/owner/site.git', 'ssh://git@github.com/owner/site.git', 'git@github.com:owner/site.git', 'https://[2001:db8:0:0:0:0:0:1]/repo', 'ssh://host.example:2222/x',
  ])('takes %s', (url) => { expect(isCloneAddress(url)).toBe(true) })

  it.each([
    'file:///etc', '/home/person/repo', './repo', 'ext::sh -c touch% /tmp/x', 'http://example.com/repo', 'git://example.com/repo', '-uploadpack=touch',
    'ssh://-oProxyCommand=touch/x', 'git@-oProxyCommand=x:repo', 'git@host:-repo', 'git@host://repo', 'https://exa mple.com/r', 'https://example.com/r\n',
    'https://-host.example/r', 'fd::17', 'repo',
  ])('refuses %s', (url) => { expect(isCloneAddress(url)).toBe(false) })

  it('takes one plain folder name and refuses any other', () => {
    expect(['site', 'my site', '.hidden', 'a.b'].map(isFolderName)).toEqual([true, true, true, true])
    expect(['.', '..', '-x', 'a/b', 'a\\b', ' padded', 'tab\t', ''].map(isFolderName)).toEqual([false, false, false, false, false, false, false, true])
  })

  it('suggests the address\'s last path part without .git, or nothing it would refuse', () => {
    expect([REPO, 'git@github.com:owner/site', 'https://example.com/site/', 'https://example.com/', 'git@host:-x.git', ''].map(suggestedName))
      .toEqual(['site', 'site', 'site', 'example.com', '', ''])
  })
})

describe('starting a clone', () => {
  it('clones into the new folder with no submodules and no prompt, then adds it and reports its folder', async () => {
    const { git, runs } = gitFake()
    const { started, settled, create } = service(git)
    const job = await started({ url: REPO, parent: join(person, 'projects'), name: 'site' })
    const destination = join(person, 'projects', 'site')
    expect(await settled(job)).toEqual({ state: 'done', workspaceId: 'workspace-9', path: destination, kind: 'empty' })
    expect(runs[0]?.args).toEqual(['clone', '--progress', '--no-recurse-submodules', '--', REPO, destination])
    expect(create).toHaveBeenCalledExactlyOnceWith(destination)
  })

  it.each([
    ['url-form', { url: 'file:///etc', name: 'x' }],
    ['url-form', { url: 'ext::sh -c touch% /tmp/pwned', name: 'x' }],
    ['url-form', { url: '--upload-pack=touch /tmp/pwned', name: 'x' }],
    ['url-form', { url: 'ssh://-oProxyCommand=touch/x', name: 'x' }],
    ['name-form', { url: REPO, name: '../escape' }],
    ['name-form', { url: REPO, name: '-x' }],
  ] as const)('refuses %s before Git runs: %o', async (problem, body) => {
    const { git, runs } = gitFake()
    const { start } = service(git)
    expect(await start({ ...body, parent: join(person, 'projects') })).toEqual({ status: 422, body: { result: 'refused', problem } })
    expect(runs).toEqual([])
  })

  it('refuses a parent that is not absolute', async () => {
    const { git, runs } = gitFake()
    expect((await service(git).start({ url: REPO, parent: 'projects', name: 'site' })).body).toEqual({ result: 'refused', problem: 'not-absolute' })
    expect(runs).toEqual([])
  })

  it('refuses a folder inside the Delo home, also through a symlink, and the home directory itself', async () => {
    await symlink(deloHome, join(person, 'projects', 'link'))
    const { git, runs } = gitFake()
    const { start } = service(git)
    expect((await start({ url: REPO, parent: deloHome, name: 'inside' })).body).toEqual({ result: 'refused', problem: 'delo-home' })
    expect((await start({ url: REPO, parent: join(person, 'projects', 'link'), name: 'new' })).body).toEqual({ result: 'refused', problem: 'delo-home' })
    expect((await start({ url: REPO, parent: join(person, '.dsh'), name: 'new' })).body).toEqual({ result: 'refused', problem: 'stock-home' })
    expect((await start({ url: REPO, parent: join(scratch, 'a', 'b'), name: 'person' })).body).toEqual({ result: 'refused', problem: 'home-directory' })
    expect(runs).toEqual([])
  })

  it('refuses a folder that holds something, and a file in the folder\'s place', async () => {
    await mkdir(join(person, 'projects', 'used'))
    await writeFile(join(person, 'projects', 'used', 'keep.txt'), 'kept')
    await writeFile(join(person, 'projects', 'file'), 'kept')
    const { git, runs } = gitFake()
    const { start } = service(git)
    for (const name of ['used', 'file']) expect((await start({ url: REPO, parent: join(person, 'projects'), name })).body).toEqual({ result: 'refused', problem: 'not-empty' })
    expect(runs).toEqual([])
  })

  it('answers 500 and runs nothing when the Delo home cannot be resolved', async () => {
    vi.stubEnv('DELO_HOME', 'relative/home')
    const { git, runs } = gitFake()
    const { start, warn } = service(git)
    expect((await start({ url: REPO, parent: join(person, 'projects'), name: 'site' })).status).toBe(500)
    expect(runs).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
  })

  it.each([
    ['not JSON', '{'],
    ['a missing field', { url: REPO, parent: '/x' }],
    ['an extra field', { url: REPO, parent: '/x', name: 'x', depth: 1 }],
    ['an oversized body', 'x'.repeat(MAX_CLONE_BODY_BYTES + 1)],
  ])('answers 400 for %s', async (_, body) => {
    const { git, runs } = gitFake()
    expect((await service(git).start(body)).status).toBe(400)
    expect(runs).toEqual([])
  })

  it('refuses a second clone while one runs, and takes one again once it finishes', async () => {
    const held = heldGit()
    const { start, settled, started } = service(held.git)
    const job = await started({ url: REPO, parent: join(person, 'projects'), name: 'one' })
    expect((await start({ url: REPO, parent: join(person, 'projects'), name: 'two' })).body).toEqual({ result: 'refused', problem: 'busy' })
    held.finish({ kind: 'exited', code: 128, stderr: 'fatal: Repository not found.' })
    expect(await settled(job)).toEqual({ state: 'failed', failure: 'not-found' })
    expect(CloneStart.parse((await start({ url: REPO, parent: join(person, 'projects'), name: 'two' })).body).result).toBe('started')
  })
})

describe('a running clone', () => {
  it('reports the last percent Git received, never over 100', async () => {
    let report: (text: string) => void = () => {}
    const held = heldGit()
    const git: GitRunner = (args, env, signal, onStderr) => { report = onStderr; return held.git(args, env, signal, onStderr) }
    const { started, status } = service(git)
    const job = await started({ url: REPO, parent: join(person, 'projects'), name: 'site' })
    expect(await status(job)).toEqual({ state: 'running' })
    report('Counting objects: 50%\rReceiving objects:  12% (1/8)\rReceiving objects:  42% (3/8)')
    expect(await status(job)).toEqual({ state: 'running', percent: 42 })
    report('Resolving deltas: 90%')
    expect(await status(job)).toEqual({ state: 'running', percent: 42 })
    report('Receiving objects: 999%')
    expect(await status(job)).toEqual({ state: 'running', percent: 100 })
  })

  it('fails with timeout and removes the folder it created once the time is up', async () => {
    const held = heldGit()
    const { started, settled, warn } = service(held.git, { timeoutMs: 10 })
    const job = await started({ url: REPO, parent: join(person, 'projects'), name: 'site' })
    await mkdir(join(person, 'projects', 'site', '.git'), { recursive: true })
    expect(await settled(job)).toEqual({ state: 'failed', failure: 'timeout' })
    await expect(stat(join(person, 'projects', 'site'))).rejects.toThrow()
    expect(warn).toHaveBeenCalledExactlyOnceWith('a clone failed: timeout')
  })

  it('empties a folder that was empty before and keeps the folder itself', async () => {
    await mkdir(join(person, 'projects', 'site'))
    const { git } = gitFake(async (args) => {
      await writeFile(join(args.at(-1) as string, 'partial'), 'x')
      return { kind: 'exited', code: 128, stderr: 'fatal: unable to access: Could not resolve host: github.com' }
    })
    const { started, settled } = service(git)
    expect(await settled(await started({ url: REPO, parent: join(person, 'projects'), name: 'site' }))).toEqual({ state: 'failed', failure: 'network' })
    expect(await readdir(join(person, 'projects', 'site'))).toEqual([])
  })

  it('fails with no-git when Git is not installed', async () => {
    const { started, settled } = service(gitFake(async () => ({ kind: 'missing' })).git)
    expect(await settled(await started({ url: REPO, parent: join(person, 'projects'), name: 'site' }))).toEqual({ state: 'failed', failure: 'no-git' })
  })

  it('fails with add-failed when the cloned folder cannot be added', async () => {
    const { started, settled } = service(gitFake().git, { create: async () => { throw Object.assign(new Error('/private/path'), { code: 'EEXIST' }) } })
    expect(await settled(await started({ url: REPO, parent: join(person, 'projects'), name: 'site' }))).toEqual({ state: 'failed', failure: 'add-failed' })
  })

  it('fails without naming the error when the run itself throws', async () => {
    const { started, settled, warn } = service(gitFake(async () => { throw new TypeError('https://token@example.com') }).git)
    expect(await settled(await started({ url: REPO, parent: join(person, 'projects'), name: 'site' }))).toEqual({ state: 'failed', failure: 'failed' })
    expect(warn).toHaveBeenCalledExactlyOnceWith('a clone stopped unexpectedly: TypeError')
  })

  it('logs a non-Error throw without its value', async () => {
    const { started, settled, warn } = service(gitFake(() => Promise.reject('secret')).git)
    await settled(await started({ url: REPO, parent: join(person, 'projects'), name: 'site' }))
    expect(warn).toHaveBeenCalledExactlyOnceWith('a clone stopped unexpectedly: unexpected failure')
  })

  it('stops a running clone and forgets every job when disposed', async () => {
    const held = heldGit()
    const { clones, started, status } = service(held.git)
    const job = await started({ url: REPO, parent: join(person, 'projects'), name: 'site' })
    clones.dispose()
    expect(await status(job)).toEqual({ state: 'unknown' })
  })
})

describe('reading a clone', () => {
  it('answers unknown for a job it does not know, and 400 for a request it cannot read', async () => {
    const { clones, status } = service(gitFake().git)
    expect(await status('no-such-job')).toEqual({ state: 'unknown' })
    for (const body of ['{', JSON.stringify({ job: '' }), JSON.stringify({ job: 'x', more: 1 })]) {
      expect((await clones.status(new Request('http://harness.test/api', { method: 'POST', body }))).status).toBe(400)
    }
  })

  it('keeps only the newest finished outcomes', async () => {
    const { started, settled, status } = service(gitFake(async () => ({ kind: 'exited', code: 1, stderr: '' })).git)
    const jobs: string[] = []
    for (let n = 0; n < 18; n++) {
      const job = await started({ url: REPO, parent: join(person, 'projects'), name: `site-${n}` })
      await settled(job)
      jobs.push(job)
    }
    expect((await status(jobs[0] as string)).state).toBe('unknown')
    expect((await status(jobs[1] as string)).state).toBe('unknown')
    expect((await status(jobs[2] as string)).state).toBe('failed')
    expect((await status(jobs[17] as string)).state).toBe('failed')
  })
})

describe('telling a failure from Git\'s output', () => {
  it.each([
    ['fatal: could not read Username for \'https://github.com\': terminal prompts disabled', 'sign-in'],
    ['git@github.com: Permission denied (publickey).', 'sign-in'],
    ['Host key verification failed.', 'sign-in'],
    ['The requested URL returned error: 403', 'sign-in'],
    ['remote: Repository not found.', 'not-found'],
    ['The requested URL returned error: 404', 'not-found'],
    ['fatal: Could not resolve host: github.com', 'network'],
    ['ssh: connect to host example.com port 22: Connection refused', 'network'],
    ['fatal: something else', 'failed'],
  ])('reads %s as %s', (stderr, failure) => { expect(failureOf(stderr)).toBe(failure) })
})

describe('the environment Git runs in', () => {
  it('keeps where it runs and how it reaches the network, drops the rest, and turns every prompt off', () => {
    const env = cloneEnvironment({ PATH: '/bin', HOME: '/home/p', SSH_AUTH_SOCK: '/s', HTTPS_PROXY: 'http://proxy', DEEPSEEK_API_KEY: 'sk-x', GIT_ASKPASS: '/bin/ask', GIT_CONFIG_PARAMETERS: "'core.sshCommand=x'", UNSET: undefined })
    expect(env).toEqual({
      PATH: '/bin', HOME: '/home/p', SSH_AUTH_SOCK: '/s', HTTPS_PROXY: 'http://proxy',
      GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GIT_ALLOW_PROTOCOL: 'https:ssh', LC_ALL: 'C',
    })
  })
})

describe('real Git', () => {
  /** A local HTTP server that answers every request with 401 and a Basic challenge. */
  async function challengeServer(): Promise<{ readonly url: string; readonly hits: () => number }> {
    let hits = 0
    const server: Server = createServer((_request, response) => {
      hits++
      response.writeHead(401, { 'www-authenticate': 'Basic realm="test"' }).end()
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    onTestFinished(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`, hits: () => hits }
  }

  /** The clone environment over an empty home, so the person's Git configuration and credential helpers stay out. */
  const isolated = (extra: Record<string, string> = {}) => ({
    ...cloneEnvironment({ PATH: process.env.PATH, HOME: join(scratch, 'git-home') }),
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  })

  /** Run Git as the service does, with a deadline the test fails on instead of hanging. */
  async function run(url: string, env: Record<string, string>): Promise<GitOutcome> {
    const abort = new AbortController()
    const deadline = setTimeout(() => { abort.abort() }, 20_000)
    try {
      return await spawnGit(['clone', '--progress', '--no-recurse-submodules', '--', url, join(person, 'projects', 'out')], env, abort.signal, () => {})
    } finally {
      clearTimeout(deadline)
    }
  }

  it('fails at once with sign-in instead of asking, when a server wants one', async () => {
    const server = await challengeServer()
    const outcome = await run(server.url, isolated({ GIT_ALLOW_PROTOCOL: 'https:ssh:http' }))
    expect(outcome.kind === 'exited' && outcome.code !== 0 && outcome.code !== null).toBe(true)
    expect(failureOf(outcome.kind === 'exited' ? outcome.stderr : '')).toBe('sign-in')
    expect(server.hits()).toBeGreaterThan(0)
  }, 30_000)

  it.each(['http', 'file', 'ext'])('refuses the %s transport the environment does not allow', async (scheme) => {
    const server = await challengeServer()
    const url = scheme === 'http' ? server.url : scheme === 'file' ? `file://${person}` : 'ext::sh -c true'
    const outcome = await run(url, isolated())
    expect(outcome.kind === 'exited' && outcome.code !== 0).toBe(true)
    expect(outcome.kind === 'exited' ? outcome.stderr : '').toMatch(/transport '\w+' not allowed/u)
    expect(server.hits()).toBe(0)
  }, 30_000)

  it('reports missing when git cannot be found', async () => {
    expect(await spawnGit(['--version'], { PATH: join(scratch, 'empty') }, new AbortController().signal, () => {})).toEqual({ kind: 'missing' })
  })

  it('reports a Git it cannot start as a failed run', async () => {
    const bin = join(scratch, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'git'), '#!/bin/sh\n', { mode: 0o644 })
    expect(await spawnGit(['--version'], { PATH: bin }, new AbortController().signal, () => {})).toEqual({ kind: 'exited', code: null, stderr: '' })
  })

  it('kills Git when the signal aborts', async () => {
    const abort = new AbortController()
    const server = createServer(() => { abort.abort() })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    onTestFinished(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`
    const outcome = await spawnGit(['clone', '--', url, join(person, 'projects', 'out')], isolated({ GIT_ALLOW_PROTOCOL: 'http' }), abort.signal, () => {})
    expect(outcome).toMatchObject({ kind: 'exited', code: null })
  }, 30_000)
})
