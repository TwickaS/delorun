/**
 * The clone step: the refusals before any process starts, the arguments and
 * environment a clone spawns with, the failure reasons and progress, and real
 * clones from the local HTTPS fixture (the credential helper, the certificate
 * check and the time limit). The refusal, argument, and reason specs use a
 * scripted subprocess provider that records each spawn; the real-git specs run
 * git through a provider that starts each clone in its own process group.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type CloneOptions, type CloneResult, cloneRepository } from '../src/clone.ts'
import { tokenGit } from '../src/git.ts'
import { type GitFixture, startGitFixture } from './fixtures/git-server.ts'

/** A token the checks accept, for the scripted specs; the real-git specs use the fixture's own password. */
const TOKEN = 'fixture-token-for-clone-specs'

/** A token the private repository refuses. */
const WRONG_TOKEN = 'fixture-wrong-password-not-a-credential'

/** A clone URL the scripted specs never contact. */
const UNREACHED_URL = 'https://127.0.0.1:1/owner/repo.git'

/** URLs the refusal rule stops before any process starts. */
const REFUSED_URLS = [
  `https://user:delo-test-password-not-a-secret@127.0.0.1:1/owner/repo.git`,
  'https://user@127.0.0.1:1/owner/repo.git',
  'http://127.0.0.1:1/owner/repo.git',
  'ssh://git@127.0.0.1:1/owner/repo.git',
  'file:///srv/repo.git',
  'https://127.0.0.1:1/owner/repo.git?ref=main',
  'https://127.0.0.1:1/owner/repo.git#main',
]

/** The clone inputs a spec builds, with the warnings and progress lines the clone reports. */
interface Inputs {
  readonly options: CloneOptions
  readonly warnings: string[]
  readonly progress: string[]
}

/** What a scripted spawn writes and how it ends. */
interface Script {
  /** Text the process writes to its error stream. */
  readonly stderr?: string
  /** The exit code of a process that is not `hang`ing. */
  readonly exitCode?: number
  /** The process runs until the spawn signal aborts, then exits by SIGTERM. */
  readonly hang?: boolean
  /** The error stream stays open after the process exits. */
  readonly openStderr?: boolean
  /** The error stream fails with this message, so reading it raises an error. */
  readonly failStderr?: string
  /** The spawn throws this message instead of returning a handle. */
  readonly throwOnSpawn?: string
  /** The handle carries no error stream, although the spawn asked for one. */
  readonly noErrorPipe?: boolean
  /** The outcome rejects with this message. */
  readonly rejectDone?: string
}

/**
 * The fixture's start, begun when the file loads. Its outcome is kept as a
 * value, so a failure (openssl missing, for one) reaches each test as that
 * test's error instead of skipping the tests.
 */
const started = startGitFixture().then(
  (value): { readonly fixture: GitFixture } | { readonly error: unknown } => ({ fixture: value }),
  (error: unknown): { readonly fixture: GitFixture } | { readonly error: unknown } => ({ error }),
)

/** The running fixture of the current test. */
let fixture: GitFixture | undefined

/** The environment values a test changed, with what to restore. */
let savedEnv: Record<string, string | undefined> = {}

/** A scratch directory for each spec, removed after it. */
let scratch = ''

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'delo-clone-spec-'))
  const outcome = await started
  if ('error' in outcome) throw outcome.error
  fixture = outcome.fixture
  savedEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
  process.env.HOME = outcome.fixture.home
  process.env.XDG_CONFIG_HOME = join(outcome.fixture.home, '.config')
}, 60_000)

afterEach(async () => {
  restoreEnv(savedEnv)
  await rm(scratch, { recursive: true, force: true })
})

afterAll(async () => {
  const outcome = await started
  if ('fixture' in outcome) await outcome.fixture.close()
})

describe('cloneRepository refusals', () => {
  it.each(REFUSED_URLS)('refuses %s before any process starts', async (url) => {
    const { runtime, specs } = scripted({})
    const reason = reasonOf(await cloneRepository(inputs(runtime, { url }).options))
    expect(specs).toHaveLength(0)
    expect(reason).toBe('the repository URL must be an https URL without a user name, password, query or fragment')
  })

  it.each([
    ['empty', ''],
    ['made of two words', 'two words'],
    ['made of two lines', 'line one\nline two'],
    ['longer than 4096 characters', 'x'.repeat(4097)],
  ])('refuses a token that is %s before any process starts', async (_label, token) => {
    const { runtime, specs } = scripted({})
    const reason = reasonOf(await cloneRepository(inputs(runtime, { url: UNREACHED_URL, token }).options))
    expect(specs).toHaveLength(0)
    expect(reason).toBe('the token must be one line of at most 4096 printable ASCII characters without whitespace')
  })
})

describe('the arguments and environment a clone spawns with', () => {
  it('passes the token only to the credential helper, never in argv or the clone URL', async () => {
    const { runtime, specs } = scripted({})
    const result = await cloneRepository(inputs(runtime, { url: UNREACHED_URL, token: TOKEN }).options)
    expect(result).toEqual({ ok: true })
    const spec = onlySpec(specs)
    expect(spec.argv.join('\n')).not.toContain(TOKEN)
    expect(spec.argv.slice(-5)).toEqual(['clone', '--progress', '--', UNREACHED_URL, '.'])
    expect(spec.env).toMatchObject({ DELO_GIT_TOKEN: TOKEN })
  })

  it('clears the git variables a parent environment sets, whatever their suffix', async () => {
    const { runtime, specs } = scripted({})
    const result = await withEnv({ GIT_CONFIG_KEY_0: 'core.pager', GIT_TRACE2_EVENT: '/tmp/trace', GIT_ASKPASS: '/bin/ask', GIT_DIR: '/elsewhere' },
      () => cloneRepository(inputs(runtime, { url: UNREACHED_URL }).options))
    expect(result).toEqual({ ok: true })
    const env = onlySpec(specs).env ?? {}
    for (const name of ['GIT_CONFIG_KEY_0', 'GIT_TRACE2_EVENT', 'GIT_ASKPASS', 'GIT_DIR']) {
      expect(Object.hasOwn(env, name), name).toBe(true)
      expect(env[name], name).toBeUndefined()
    }
  })

  it('passes the extra certificate authority as http.sslCAInfo, and leaves it out by default', async () => {
    const withCa = scripted({})
    await cloneRepository(inputs(withCa.runtime, { url: UNREACHED_URL, extraCaFile: '/etc/delo/private-ca.pem' }).options)
    expect(onlySpec(withCa.specs).argv).toContain('http.sslCAInfo=/etc/delo/private-ca.pem')
    const plain = scripted({})
    await cloneRepository(inputs(plain.runtime, { url: UNREACHED_URL }).options)
    expect(onlySpec(plain.specs).argv.some((arg) => arg.includes('sslCAInfo'))).toBe(false)
  })

  it('stops the clone at its time limit through the spawn signal', async () => {
    const { runtime, specs } = scripted({ hang: true })
    const reason = reasonOf(await cloneRepository(inputs(runtime, { url: UNREACHED_URL, timeoutMs: 50 }).options))
    expect(reason).toBe('the clone did not finish within 50 ms; git was stopped by SIGTERM')
    expect(onlySpec(specs).signal).toBeInstanceOf(AbortSignal)
    expect(onlySpec(specs).signal?.aborted).toBe(true)
  })

  it('stops the clone when the caller cancels it', async () => {
    const { runtime } = scripted({ hang: true })
    const controller = new AbortController()
    const pending = cloneRepository(inputs(runtime, { url: UNREACHED_URL, signal: controller.signal }).options)
    controller.abort()
    expect(reasonOf(await pending)).toBe('the clone was cancelled; git was stopped by SIGTERM')
  })
})

describe('failure reasons and progress', () => {
  it('keeps the latest five fatal or error lines, each cut to 300 characters', async () => {
    const lines = Array.from({ length: 7 }, (_, index) => `fatal: failure ${index} ${'x'.repeat(1000)}`)
    const { runtime } = scripted({ stderr: `${lines.join('\n')}\n`, exitCode: 128 })
    const reason = reasonOf(await cloneRepository(inputs(runtime, { url: UNREACHED_URL }).options))
    const [facts, ...reasonLines] = reason.split('\n')
    expect(facts).toBe('git exited with code 128')
    expect(reasonLines).toEqual(lines.slice(2).map((line) => line.slice(0, 300)))
  })

  it('names the exit code when git writes no error line', async () => {
    const { runtime } = scripted({ stderr: 'Receiving objects: 40%\n', exitCode: 128 })
    expect(reasonOf(await cloneRepository(inputs(runtime, { url: UNREACHED_URL }).options))).toBe('git exited with code 128')
  })

  it('keeps a last line that has no line break', async () => {
    const { runtime } = scripted({ stderr: 'fatal: the last line has no line break', exitCode: 128 })
    expect(reasonOf(await cloneRepository(inputs(runtime, { url: UNREACHED_URL }).options)))
      .toBe('git exited with code 128\nfatal: the last line has no line break')
  })

  it('reports each carriage-return update of git progress as its own line', async () => {
    const { runtime } = scripted({ stderr: 'Receiving objects: 10%\rReceiving objects: 20%\r\nfatal: stopped\r\n', exitCode: 128 })
    const io = inputs(runtime, { url: UNREACHED_URL })
    expect(reasonOf(await cloneRepository(io.options))).toBe('git exited with code 128\nfatal: stopped')
    expect(io.progress).toEqual(['Receiving objects: 10%', 'Receiving objects: 20%'])
  })

  it('drops a line longer than 4096 characters whole, so no part of a token in it shows', async () => {
    const longLine = `fatal: ${'a'.repeat(4000)}${TOKEN}${'b'.repeat(200)}`
    const { runtime } = scripted({ stderr: `${longLine}\nReceiving objects: 9%\n`, exitCode: 128 })
    const io = inputs(runtime, { url: UNREACHED_URL, token: TOKEN })
    expect(reasonOf(await cloneRepository(io.options))).toBe('git exited with code 128')
    expect(io.progress).toEqual(['Receiving objects: 9%'])
  })

  it('rejects when the provider returns no error pipe for a spawn that asked for one', async () => {
    const { runtime } = scripted({ noErrorPipe: true })
    await expect(cloneRepository(inputs(runtime, { url: UNREACHED_URL }).options)).rejects.toThrow('no stderr pipe')
  })

  it('redacts the token from the reason and from the progress lines', async () => {
    const { runtime } = scripted({ stderr: `Receiving objects: 50% ${TOKEN}\nfatal: could not use ${TOKEN}\n`, exitCode: 128 })
    const io = inputs(runtime, { url: UNREACHED_URL, token: TOKEN })
    expect(reasonOf(await cloneRepository(io.options))).toBe('git exited with code 128\nfatal: could not use [redacted]')
    expect(io.progress).toEqual(['Receiving objects: 50% [redacted]'])
  })

  it('reports a progress callback that throws as a warning that holds no token, and finishes the clone', async () => {
    const { runtime } = scripted({ stderr: 'Receiving objects: 50%\n' })
    const io = inputs(runtime, {
      url: UNREACHED_URL,
      token: TOKEN,
      onProgress: () => { throw new Error(`the callback saw ${TOKEN}`) },
    })
    expect(await cloneRepository(io.options)).toEqual({ ok: true })
    expect(io.warnings).toEqual(['git clone: the progress callback threw, so its line was not reported: the callback saw [redacted]'])
  })

  it('reports a spawn that throws as the reason', async () => {
    const { runtime } = scripted({ throwOnSpawn: 'spawn git ENOENT' })
    expect(reasonOf(await cloneRepository(inputs(runtime, { url: UNREACHED_URL }).options))).toBe('git could not run: spawn git ENOENT')
  })

  it('reports an outcome that rejects as the reason', async () => {
    const { runtime } = scripted({ rejectDone: 'the provider lost the process' })
    expect(reasonOf(await cloneRepository(inputs(runtime, { url: UNREACHED_URL }).options))).toBe('git could not run: the provider lost the process')
  })

  it('warns when the error output fails to read, without a crash, and still reports git\'s exit', async () => {
    const { runtime } = scripted({ failStderr: 'read failed for token-free pipe', exitCode: 0 })
    const io = inputs(runtime, { url: UNREACHED_URL })
    expect(await cloneRepository(io.options)).toEqual({ ok: true })
    expect(io.warnings).toEqual(['git clone: reading its error output failed: read failed for token-free pipe'])
  })

  it('warns when the error output stays open after git exits', async () => {
    const { runtime } = scripted({ openStderr: true, exitCode: 0 })
    const io = inputs(runtime, { url: UNREACHED_URL })
    expect(await cloneRepository(io.options)).toEqual({ ok: true })
    expect(io.warnings).toEqual([expect.stringContaining('stayed open after git exited')])
  }, 15_000)
})

describe('git over the local HTTPS fixture', () => {
  it('clones a public repository through the extra authority, without a credential', async () => {
    const directory = await emptyDirectory()
    const { origin, caFile } = running()
    const io = inputs(nodeRuntime(), { url: `${origin}/public.git`, directory, extraCaFile: caFile })
    expect(await cloneRepository(io.options)).toEqual({ ok: true })
    expect(await readFile(join(directory, 'README.md'), 'utf8')).toContain('fixture')
    expect(gitOut(['-C', directory, 'remote', 'get-url', 'origin'])).toBe(`${origin}/public.git`)
    expect(io.progress.length).toBeGreaterThan(0)
  })

  it('clones a private repository with the token, and no token reaches the stored URL or the config', async () => {
    const directory = await emptyDirectory()
    const { origin, caFile, password } = running()
    const url = `${origin}/private.git`
    const mark = running().requests.length
    const result = await cloneRepository(inputs(nodeRuntime(), { url, directory, extraCaFile: caFile, token: password }).options)
    expect(result).toEqual({ ok: true })
    expect(gitOut(['-C', directory, 'remote', 'get-url', 'origin'])).toBe(url)
    expect(await readFile(join(directory, '.git', 'config'), 'utf8')).not.toContain(password)
    expect(running().requests.slice(mark).some((request) => request.path === '/private.git/info/refs' && request.credential)).toBe(true)
  })

  it('refuses a private repository without a token, and sends no credential', async () => {
    const directory = await emptyDirectory()
    const { origin, caFile } = running()
    const mark = running().requests.length
    const reason = reasonOf(await cloneRepository(inputs(nodeRuntime(), { url: `${origin}/private.git`, directory, extraCaFile: caFile }).options))
    expect(reason).toContain('fatal:')
    const sent = running().requests.slice(mark)
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every((request) => !request.credential)).toBe(true)
  })

  it('refuses a wrong token with the authentication failure git reports, and the reason holds no token', async () => {
    const directory = await emptyDirectory()
    const { origin, caFile } = running()
    const reason = reasonOf(await cloneRepository(inputs(nodeRuntime(), {
      url: `${origin}/private.git`,
      directory,
      extraCaFile: caFile,
      token: WRONG_TOKEN,
    }).options))
    expect(reason).toContain('Authentication failed')
    expect(reason).not.toContain(WRONG_TOKEN)
  })

  it('verifies the server certificate when no extra authority is given', async () => {
    const directory = await emptyDirectory()
    const reason = reasonOf(await cloneRepository(inputs(nodeRuntime(), { url: `${running().origin}/public.git`, directory }).options))
    expect(reason).toMatch(/certificate/i)
  })

  it('verifies the certificate of a token clone even when the configuration turns verification off', async () => {
    const directory = await emptyDirectory()
    const { origin, home, password } = running()
    const configPath = join(home, '.gitconfig')
    await writeFile(configPath, '[http]\n\tsslVerify = false\n')
    try {
      const reason = reasonOf(await cloneRepository(inputs(nodeRuntime(), { url: `${origin}/private.git`, directory, token: password }).options))
      expect(reason).toMatch(/certificate/i)
    } finally {
      await rm(configPath, { force: true })
    }
  })

  it('answers with the token when the configuration names a credential helper of its own', async () => {
    const directory = await emptyDirectory()
    const { origin, caFile, password, home } = running()
    const configPath = join(home, '.gitconfig')
    await writeFile(configPath, '[credential]\n\thelper = "!echo username=person; echo password=wrong-from-configuration"\n')
    try {
      const result = await cloneRepository(inputs(nodeRuntime(), { url: `${origin}/private.git`, directory, extraCaFile: caFile, token: password }).options)
      expect(result).toEqual({ ok: true })
    } finally {
      await rm(configPath, { force: true })
    }
  })

  it('stops a clone that passes its time limit, and its helper processes with it', async () => {
    const directory = await emptyDirectory()
    const { origin, caFile } = running()
    const io = inputs(nodeRuntime(), { url: `${origin}/stall.git`, directory, extraCaFile: caFile, timeoutMs: 500 })
    expect(reasonOf(await cloneRepository(io.options))).toBe('the clone did not finish within 500 ms; git was stopped by SIGTERM')
    expect(io.warnings).toEqual([])
  })

  it('answers the token only over https, for the clone URL host and path', () => {
    const { origin, password } = running()
    const invocation = tokenGit(`${origin}/private.git`, password)
    const env = applyEnv(gitEnv(), invocation.env)
    const host = new URL(origin).host
    const ask = (input: string): string => spawnSync('git', [...invocation.options, 'credential', 'fill'], { env, input, encoding: 'utf8' }).stdout
    expect(ask(`protocol=https\nhost=${host}\npath=private.git\n\n`)).toContain(`password=${password}`)
    expect(ask(`protocol=http\nhost=${host}\npath=private.git\n\n`)).not.toContain(password)
    expect(ask(`protocol=https\nhost=127.0.0.1:1\npath=private.git\n\n`)).not.toContain(password)
    expect(ask(`protocol=https\nhost=${host}\npath=other.git\n\n`)).not.toContain(password)
  })
})

/**
 * The running fixture.
 * @returns the fixture; throws when the current test has none.
 */
function running(): GitFixture {
  if (fixture === undefined) throw new Error('the git fixture is not running')
  return fixture
}

/**
 * The clone inputs for one spec, rooted in its scratch directory.
 * @param subprocess - the provider the spec runs git through.
 * @param overrides - the options the spec sets.
 * @returns the options and the lists the clone's warnings and progress lines go to.
 */
function inputs(subprocess: SubprocessRuntime, overrides: Partial<CloneOptions>): Inputs {
  const warnings: string[] = []
  const progress: string[] = []
  const options: CloneOptions = {
    subprocess,
    url: UNREACHED_URL,
    directory: join(scratch, 'workspace'),
    timeoutMs: 60_000,
    warn: (message) => { warnings.push(message) },
    onProgress: (line) => { progress.push(line) },
    ...overrides,
  }
  return { options, warnings, progress }
}

/**
 * A new empty directory in the spec's scratch directory.
 * @returns its absolute path.
 */
function emptyDirectory(): Promise<string> {
  return mkdtemp(join(scratch, 'clone-'))
}

/**
 * The reason of a clone that failed; the spec fails when the clone succeeded.
 * @param result - the clone's result.
 * @returns the reason.
 */
function reasonOf(result: CloneResult): string {
  if (result.ok) throw new Error('expected the clone to fail')
  return result.reason
}

/**
 * The one spawn a spec made.
 * @param specs - the spawns the provider recorded.
 * @returns the spawn.
 */
function onlySpec(specs: readonly SubprocessSpawnSpec[]): SubprocessSpawnSpec {
  const [spec] = specs
  if (spec === undefined || specs.length !== 1) throw new Error(`expected one spawn, saw ${specs.length}`)
  return spec
}

/**
 * A subprocess provider that records each spawn and answers from a script
 * instead of starting a process.
 * @param script - what each spawn does.
 * @returns the provider and the recorded spawns.
 */
function scripted(script: Script): { readonly runtime: SubprocessRuntime, readonly specs: SubprocessSpawnSpec[] } {
  const specs: SubprocessSpawnSpec[] = []
  const runtime = {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      specs.push(spec)
      if (script.throwOnSpawn !== undefined) throw new Error(script.throwOnSpawn)
      const stderr = script.noErrorPipe === true ? undefined : errorStream(script)
      return handleOf(stderr, outcomeOf(script, spec), () => undefined)
    },
  } as SubprocessRuntime
  return { runtime, specs }
}

/**
 * The error stream a scripted process writes.
 * @param script - the text to write, and whether the stream stays open.
 * @returns the stream.
 */
function errorStream(script: Script): PassThrough {
  const stream = new PassThrough()
  if (script.openStderr === true) stream.write(script.stderr ?? '')
  else stream.end(script.stderr ?? '')
  if (script.failStderr !== undefined) stream.destroy(new Error(script.failStderr))
  return stream
}

/**
 * The outcome a scripted spawn settles with.
 * @param script - what the spawn does.
 * @param spec - the spawn, whose signal ends a hanging process.
 * @returns the outcome promise.
 */
function outcomeOf(script: Script, spec: SubprocessSpawnSpec): Promise<SubprocessOutcome> {
  if (script.rejectDone !== undefined) return Promise.reject(new Error(script.rejectDone))
  if (script.hang === true) {
    return new Promise((resolve) => {
      spec.signal?.addEventListener('abort', () => { resolve({ exitCode: null, signal: 'SIGTERM' }) }, { once: true })
    })
  }
  return Promise.resolve({ exitCode: script.exitCode ?? 0, signal: null })
}

/**
 * A subprocess provider over node:child_process, for the specs that run git.
 * Each spawn leads its own process group, which stands for the managed range:
 * stopping the spawn also stops the helper processes git starts.
 * @returns the provider.
 */
function nodeRuntime(): SubprocessRuntime {
  return {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      const [program = '', ...args] = spec.argv
      const child = spawn(program, args, { cwd: spec.cwd, env: applyEnv(process.env, spec.env ?? {}), detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
      const stop = (): void => {
        if (child.pid === undefined) return
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          // ESRCH: the process group has already exited, so there is nothing left to stop.
        }
      }
      if (spec.signal?.aborted === true) stop()
      spec.signal?.addEventListener('abort', stop, { once: true })
      const done = new Promise<SubprocessOutcome>((resolve, reject) => {
        child.once('error', (error) => { if (child.pid === undefined) reject(error) })
        child.once('close', (exitCode, signal) => { resolve({ exitCode, signal }) })
      })
      return handleOf(child.stderr ?? undefined, done, stop)
    },
  } as SubprocessRuntime
}

/**
 * A subprocess handle with the given error stream and outcome. The clone reads
 * only the stream and the outcome; the handle's other members are inert.
 * @param stderr - the error stream, or undefined when none was requested.
 * @param done - the outcome.
 * @param terminate - what stops the process.
 * @returns the handle.
 */
function handleOf(stderr: Readable | undefined, done: Promise<SubprocessOutcome>, terminate: () => void): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr,
    control: undefined,
    collected: {},
    done,
    terminate,
    waitForExit: () => done.then(() => true, () => true),
  }
}

/**
 * Put back the environment values a spec changed.
 * @param saved - each name with its value before the change; undefined when the name was absent.
 */
function restoreEnv(saved: Readonly<Record<string, string | undefined>>): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

/**
 * Run a body with environment variables set, then restore them.
 * @param overrides - the values to set.
 * @param body - the spec's work.
 * @returns the body's result.
 */
async function withEnv<T>(overrides: Readonly<Record<string, string>>, body: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(overrides)) {
    saved[name] = process.env[name]
    process.env[name] = value
  }
  try {
    return await body()
  } finally {
    restoreEnv(saved)
  }
}

/**
 * An environment with the given entries applied: an undefined entry removes its name.
 * @param base - the environment to start from.
 * @param entries - the entries to apply.
 * @returns the environment.
 */
function applyEnv(base: NodeJS.ProcessEnv, entries: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const [name, value] of Object.entries(entries)) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  return env
}

/**
 * The harness environment without the `GIT_` names, for the specs' own git commands.
 * @returns the environment.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith('GIT_')) env[name] = value
  }
  return env
}

/**
 * Run git for a check of the clone's result.
 * @param args - the arguments after `git`.
 * @returns the standard output without its final newline.
 */
function gitOut(args: readonly string[]): string {
  return spawnSync('git', [...args], { env: gitEnv(), encoding: 'utf8' }).stdout.trim()
}
