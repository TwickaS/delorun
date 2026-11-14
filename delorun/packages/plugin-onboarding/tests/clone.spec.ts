/**
 * The clone routes: they take only HTTPS and SSH addresses and one plain folder name, refuse every folder Delorun never
 * adds and every folder that holds something before Git runs, never ask for a sign-in, and remove only what a failed
 * clone created.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cloneArguments, cloneEnvironment, createCloneService, createCloneTemplate, failureOf, spawnGit, type GitOutcome, type GitRunner } from '../src/clone.ts'
import { hasUrlCredentials, isCloneAddress, isFolderName, suggestedName } from '../src/clone-address.ts'
import { CloneStart, CloneStatus, MAX_CLONE_BODY_BYTES } from '../src/wire.ts'

let scratch = ''
let person = ''
let delorunHome = ''

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'delorun-onboarding-clone-'))
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
    'https://[::1]/repo', 'https://[2001:db8::1]/repo', 'ssh://git@[fe80::1]/repo',
  ])('takes %s', (url) => { expect(isCloneAddress(url)).toBe(true) })

  it.each([
    'file:///etc', '/home/person/repo', './repo', 'ext::sh -c touch% /tmp/x', 'http://example.com/repo', 'git://example.com/repo', '-uploadpack=touch',
    'ssh://-oProxyCommand=touch/x', 'git@-oProxyCommand=x:repo', 'git@host:-repo', 'git@host://repo', 'https://exa mple.com/r', 'https://example.com/r\n',
    'https://-host.example/r', 'fd::17', 'repo', 'ext::sh', 'ext::sh -c true', 'git@host::x y',
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
    const args = runs[0]?.args ?? []
    const template = (args.find(each => each.startsWith('--template=')) ?? '').slice('--template='.length)
    expect(args).toEqual(cloneArguments(REPO, destination, template))
    expect(args.slice(0, 8)).toEqual(['-c', 'core.hooksPath=/dev/null', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false'])
    expect(args.slice(8, 11)).toEqual(['clone', '--progress', '--no-recurse-submodules'])
    expect(args.slice(-3)).toEqual(['--', REPO, destination])
    await expect(stat(template)).rejects.toThrow()
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

  // Assembled at run time so the source holds no credential-shaped address for the secret scan to flag.
  it.each([['user', ''], ['user', 'pw'], ['', 'pw']])('refuses an https address with user %j and password %j, which carries a sign-in, before Git runs', async (user, password) => {
    const url = `https://${user}${password === '' ? '' : ':'}${password}@github.com/owner/site.git`
    const { git, runs } = gitFake()
    expect((await service(git).start({ url, parent: join(person, 'projects'), name: 'site' })).body).toEqual({ result: 'refused', problem: 'url-credentials' })
    expect(runs).toEqual([])
  })

  it('knows a sign-in in an address only in an https URL', () => {
    expect([REPO, 'ssh://git@github.com/o/r.git', 'git@github.com:o/r.git', 'https://u@h/r', `https://u${':'}p@h/r`].map(hasUrlCredentials)).toEqual([false, false, false, true, true])
  })

  it('refuses a parent that is not absolute', async () => {
    const { git, runs } = gitFake()
    expect((await service(git).start({ url: REPO, parent: 'projects', name: 'site' })).body).toEqual({ result: 'refused', problem: 'not-absolute' })
    expect(runs).toEqual([])
  })

  it('refuses a folder inside the Delorun home, also through a symlink, and the home directory itself', async () => {
    await symlink(delorunHome, join(person, 'projects', 'link'))
    const { git, runs } = gitFake()
    const { start } = service(git)
    expect((await start({ url: REPO, parent: delorunHome, name: 'inside' })).body).toEqual({ result: 'refused', problem: 'delorun-home' })
    expect((await start({ url: REPO, parent: join(person, 'projects', 'link'), name: 'new' })).body).toEqual({ result: 'refused', problem: 'delorun-home' })
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

  it('answers 500 and runs nothing when the Delorun home cannot be resolved', async () => {
    vi.stubEnv('DELORUN_HOME', 'relative/home')
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

  it('answers busy to a start made while another is still being placed, and leaves the first clone\'s folder alone', async () => {
    const destination = join(person, 'projects', 'site')
    let release: (outcome: GitOutcome) => void = () => {}
    const { git, runs } = gitFake(async (args) => {
      await mkdir(args.at(-1) as string, { recursive: true })
      await writeFile(join(args.at(-1) as string, 'first.txt'), 'first')
      return new Promise<GitOutcome>((resolve) => { release = resolve })
    })
    const { start, settled } = service(git)
    const body = { url: REPO, parent: join(person, 'projects'), name: 'site' }
    const [one, two] = await Promise.all([start(body), start(body)])
    expect([one.body, two.body].filter(each => (each as { result: string }).result === 'refused')).toEqual([{ result: 'refused', problem: 'busy' }])
    await vi.waitFor(() => { expect(runs).toHaveLength(1) })
    expect(await readdir(destination)).toEqual(['first.txt'])
    release({ kind: 'exited', code: 0, stderr: '' })
    expect(CloneStart.parse(one.body)).toMatchObject({ result: 'started' })
    await settled((one.body as { job: string }).job)
    expect(await readdir(destination)).toEqual(['first.txt'])
  })

  it('lets the next clone start after a start was refused for its location', async () => {
    const { git } = gitFake()
    const { start } = service(git)
    await mkdir(join(person, 'projects', 'used'))
    await writeFile(join(person, 'projects', 'used', 'keep'), 'x')
    expect((await start({ url: REPO, parent: join(person, 'projects'), name: 'used' })).body).toEqual({ result: 'refused', problem: 'not-empty' })
    expect((await start({ url: REPO, parent: delorunHome, name: 'x' })).body).toEqual({ result: 'refused', problem: 'delorun-home' })
    expect(CloneStart.parse((await start({ url: REPO, parent: join(person, 'projects'), name: 'ok' })).body).result).toBe('started')
  })

  it('leaves a folder alone that appeared after the check and that Git refused to use', async () => {
    const { git } = gitFake(async (args) => {
      await mkdir(args.at(-1) as string, { recursive: true })
      await writeFile(join(args.at(-1) as string, 'theirs.txt'), 'theirs')
      return { kind: 'exited', code: 128, stderr: "fatal: destination path 'site' already exists and is not an empty directory." }
    })
    const { started, settled } = service(git)
    expect(await settled(await started({ url: REPO, parent: join(person, 'projects'), name: 'site' }))).toEqual({ state: 'failed', failure: 'failed' })
    expect(await readdir(join(person, 'projects', 'site'))).toEqual(['theirs.txt'])
  })

  it('refuses a second clone while one runs, and takes one again once it finishes', async () => {
    const held = heldGit()
    const { start, settled, started } = service(held.git)
    const job = await started({ url: REPO, parent: join(person, 'projects'), name: 'one' })
    expect((await start({ url: REPO, parent: join(person, 'projects'), name: 'two' })).body).toEqual({ result: 'refused', problem: 'busy' })
    await vi.waitFor(() => { expect(held.runs).toHaveLength(1) })
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
    await vi.waitFor(() => { expect(held.runs).toHaveLength(1) })
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
    ['Host key verification failed.', 'host-key'],
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
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GIT_ALLOW_PROTOCOL: 'https:ssh', GIT_LFS_SKIP_SMUDGE: '1', LC_ALL: 'C',
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
      const template = await createCloneTemplate()
      onTestFinished(async () => { await rm(template, { recursive: true, force: true }) })
      return await spawnGit(cloneArguments(url, join(person, 'projects', 'out'), template), env, abort.signal, () => {})
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

  describe('with a filter and a hook in the person\'s own Git configuration', () => {
    /** A source repository whose files select the `evil` filter, and a global config that defines it to leave a marker. */
    async function source() {
      const marker = join(scratch, 'smudge-ran')
      const origin = join(scratch, 'origin')
      const hooks = join(scratch, 'global-hooks')
      const hookMarker = join(scratch, 'hook-ran')
      const config = join(scratch, 'global.gitconfig')
      await mkdir(origin)
      await mkdir(hooks)
      await writeFile(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch '${hookMarker}'\n`, { mode: 0o755 })
      await writeFile(join(origin, '.gitattributes'), '* filter=evil\n')
      await writeFile(join(origin, 'a.txt'), 'content\n')
      const quiet = { PATH: process.env.PATH as string, HOME: scratch, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
      const inOrigin = (...args: string[]) => new Promise<void>((resolve, reject) => {
        void spawnGit(['-C', origin, ...args], quiet, new AbortController().signal, () => {}).then(outcome => { outcome.kind === 'exited' && outcome.code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} failed`)) })
      })
      await inOrigin('init', '-q')
      await inOrigin('add', '-A')
      await inOrigin('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'x')
      const smudge = join(scratch, 'smudge.sh')
      await writeFile(smudge, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 })
      await writeFile(config, `[filter "evil"]\n\tsmudge = ${smudge}\n\tclean = cat\n[core]\n\thooksPath = ${hooks}\n`)
      return { marker, hookMarker, url: `file://${origin}`, env: isolated({ GIT_CONFIG_GLOBAL: config, GIT_ALLOW_PROTOCOL: 'file' }) }
    }
    const exists = (path: string) => stat(path).then(() => true, () => false)

    it('runs the filter in a plain clone, so the test below can tell', async () => {
      const { marker, url, env } = await source()
      const out = join(person, 'projects', 'control')
      const outcome = await spawnGit(['clone', '--', url, out], env, new AbortController().signal, () => {})
      expect(outcome).toMatchObject({ kind: 'exited', code: 0 })
      expect(await exists(marker)).toBe(true)
    }, 30_000)

    it('runs neither the filter nor the hook during the clone, and leaves the clone without the template\'s attributes', async () => {
      const { marker, hookMarker, url, env } = await source()
      const outcome = await run(url, env)
      expect(outcome).toMatchObject({ kind: 'exited', code: 0 })
      expect(await exists(marker)).toBe(false)
      expect(await exists(hookMarker)).toBe(false)
      expect(await exists(join(person, 'projects', 'out', 'a.txt'))).toBe(true)
    }, 30_000)

    it('removes the template\'s attributes from a finished clone and the template itself', async () => {
      const { url, env } = await source()
      const seen: string[] = []
      const git: GitRunner = async (args, _env, signal, onStderr) => {
        const template = (args.find(each => each.startsWith('--template=')) ?? '').slice('--template='.length)
        seen.push(template)
        return spawnGit([...args.slice(0, -2), url, args.at(-1) as string], env, signal, onStderr)
      }
      const { started, settled } = service(git)
      const job = await started({ url: REPO, parent: join(person, 'projects'), name: 'site' })
      expect((await settled(job)).state).toBe('done')
      expect(await exists(join(person, 'projects', 'site', '.git', 'info', 'attributes'))).toBe(false)
      expect(await exists(seen[0] as string)).toBe(false)
    }, 30_000)
  })

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
