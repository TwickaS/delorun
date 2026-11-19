/**
 * The clone step: the refusals before any process starts, the arguments and
 * environment a clone spawns with, the failure reasons and progress, and real
 * clones from the local HTTPS fixture (the credential helper, the certificate
 * check and the time limit). The refusal, argument, and reason specs use a
 * scripted subprocess provider that records each spawn; the real-git specs run
 * git through a provider that starts each clone in its own process group.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { scrubbedParentEnv, type SubprocessHandle, type SubprocessOutcome, type SubprocessRuntime, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CloneOptions, type CloneResult, type CloneSpec, cloneRepository, resolveClone } from '../src/clone.ts'
import { tokenGit } from '../src/git.ts'
import { type GitFixture, startGitFixture } from './fixtures/git-server.ts'
import { type RedirectFixture, startRedirectFixture } from './fixtures/redirect-server.ts'

/** A token the checks accept, for the scripted specs; the real-git specs use the fixture's own password. */
const TOKEN = 'fixture-token-for-clone-specs'

/** A token the private repository refuses. */
const WRONG_TOKEN = 'fixture-wrong-password-not-a-credential'

/** A template directory for the specs that resolve a clone without running it. */
const TEMPLATE = '/tmp/delorun-clone-template-for-specs'

/** A clone URL the scripted specs never contact. */
const UNREACHED_URL = 'https://127.0.0.1:1/owner/repo.git'

/** URLs the refusal rule stops before any process starts. */
const REFUSED_URLS = [
  `https://user:delorun-test-password-not-a-secret@127.0.0.1:1/owner/repo.git`,
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
  /** The error stream receives these texts as separate writes, in place of `stderr`. */
  readonly stderrChunks?: readonly string[]
  /** The process ends with neither an exit code nor a signal name. */
  readonly endWithoutSignal?: boolean
  /** The spawn throws this value, which is not an Error. */
  readonly throwValue?: string
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

/** HOME and XDG_CONFIG_HOME as the process had them when this file loaded; no spec changes them. */
const homeAtLoad = process.env.HOME
const xdgConfigHomeAtLoad = process.env.XDG_CONFIG_HOME

/** A scratch directory for each spec, removed after it. */
let scratch = ''

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'delorun-clone-spec-'))
  const outcome = await started
  if ('error' in outcome) throw outcome.error
  fixture = outcome.fixture
}, 60_000)

afterEach(async () => {
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
    expect(spec.argv.slice(-3)).toEqual(['--', UNREACHED_URL, '.'])
    expect(spec.env).toMatchObject({ DELORUN_GIT_TOKEN: TOKEN })
  })

  it('clears the git variables a parent environment sets, whatever their suffix', async () => {
    const { runtime, specs } = scripted({})
    const parentEnv = { GIT_CONFIG_KEY_0: 'core.pager', GIT_TRACE2_EVENT: '/tmp/trace', GIT_ASKPASS: '/bin/ask', GIT_DIR: '/elsewhere' }
    const result = await cloneRepository(inputs(runtime, { url: UNREACHED_URL, env: parentEnv }).options)
    expect(result).toEqual({ ok: true })
    const env = onlySpec(specs).env ?? {}
    for (const name of ['GIT_CONFIG_KEY_0', 'GIT_TRACE2_EVENT', 'GIT_ASKPASS', 'GIT_DIR']) {
      expect(Object.hasOwn(env, name), name).toBe(true)
      expect(env[name], name).toBeUndefined()
    }
  })

  it('ignores the system and the person\'s global configuration and the askpass program, for a token-less clone too', async () => {
    const { runtime, specs } = scripted({})
    const parentEnv = { GIT_CONFIG_NOSYSTEM: '0', GIT_CONFIG_GLOBAL: '/home/a/.gitconfig' }
    expect(await cloneRepository(inputs(runtime, { url: UNREACHED_URL, env: parentEnv }).options)).toEqual({ ok: true })
    const spec = onlySpec(specs)
    expect(spec.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
    expect(spec.argv).toEqual(expect.arrayContaining(['core.askPass=', 'protocol.file.allow=never', 'protocol.ext.allow=never']))
  })

  it('passes the extra certificate authority as http.sslCAInfo, and leaves it out by default', async () => {
    const withCa = scripted({})
    await cloneRepository(inputs(withCa.runtime, { url: UNREACHED_URL, extraCaFile: '/etc/delorun/private-ca.pem' }).options)
    expect(onlySpec(withCa.specs).argv).toContain('http.sslCAInfo=/etc/delorun/private-ca.pem')
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

describe('resolveClone', () => {
  it('resolves a clone into its spawn without starting a process', () => {
    const { runtime, specs } = scripted({})
    const io = inputs(runtime, { url: UNREACHED_URL, token: TOKEN, extraCaFile: '/etc/delorun/private-ca.pem' })
    const resolved = resolvedOf(resolveClone(io.options, TEMPLATE))
    expect(specs).toHaveLength(0)
    expect(resolved.argv[0]).toBe('git')
    expect(resolved.argv).toEqual(expect.arrayContaining(['-c', 'http.sslCAInfo=/etc/delorun/private-ca.pem']))
    expect(resolved.argv.slice(-7)).toEqual(['clone', '--progress', '--no-recurse-submodules', `--template=${TEMPLATE}`, '--', UNREACHED_URL, '.'])
    expect(resolved.argv.join('\n')).not.toContain(TOKEN)
    expect(resolved.cwd).toBe(io.options.directory)
    expect(resolved.graceMs).toBe(5000)
    expect(resolved.env).toMatchObject({ DELORUN_GIT_TOKEN: TOKEN })
  })

  it('puts the workspaces\' own options first and the shared hardened clone arguments after them', () => {
    const { runtime } = scripted({})
    const argv = resolvedOf(resolveClone(inputs(runtime, { url: UNREACHED_URL, proxy: 'http://proxy.example:3128' }).options, TEMPLATE)).argv
    const position = (argument: string): number => argv.indexOf(argument)
    expect(position('core.askPass=')).toBeGreaterThan(-1)
    expect(position('core.askPass=')).toBeLessThan(position('http.proxy=http://proxy.example:3128'))
    expect(position('http.proxy=http://proxy.example:3128')).toBeLessThan(position('filter.lfs.smudge='))
    expect(argv.lastIndexOf('core.hooksPath=/dev/null')).toBeLessThan(position('clone'))
    expect(argv).toEqual(expect.arrayContaining(['filter.lfs.smudge=', 'filter.lfs.process=', 'filter.lfs.required=false', '--no-recurse-submodules']))
    expect(argv.filter((argument) => argument === 'clone')).toHaveLength(1)
  })

  it('gives git the parsed URL, with a lower-case host and no default port, so the token helper sees the host it was built for', () => {
    const { runtime } = scripted({})
    const resolved = resolvedOf(resolveClone(inputs(runtime, { url: 'https://EXAMPLE.Com:443/Owner/Repo.git', token: TOKEN }).options, TEMPLATE))
    expect(resolved.argv.slice(-3)).toEqual(['--', 'https://example.com/Owner/Repo.git', '.'])
    expect(resolved.env).toMatchObject({ DELORUN_GIT_HOST: 'example.com', DELORUN_GIT_PATH: 'Owner/Repo.git' })
  })

  it('passes the proxy as http.proxy only when one is given', () => {
    const { runtime } = scripted({})
    expect(resolvedOf(resolveClone(inputs(runtime, { url: UNREACHED_URL }).options, TEMPLATE)).argv.join('\n')).not.toContain('http.proxy')
    const proxied = resolvedOf(resolveClone(inputs(runtime, { url: UNREACHED_URL, proxy: 'http://proxy.example:3128' }).options, TEMPLATE))
    expect(proxied.argv).toEqual(expect.arrayContaining(['-c', 'http.proxy=http://proxy.example:3128']))
  })

  it('answers a refused URL or token in the failure shape, without starting a process', () => {
    const { runtime, specs } = scripted({})
    expect(resolveClone(inputs(runtime, { url: 'http://127.0.0.1:1/owner/repo.git' }).options, TEMPLATE)).toEqual({
      ok: false,
      reason: 'the repository URL must be an https URL without a user name, password, query or fragment',
    })
    expect(resolveClone(inputs(runtime, { url: UNREACHED_URL, token: 'two words' }).options, TEMPLATE)).toEqual({
      ok: false,
      reason: 'the token must be one line of at most 4096 printable ASCII characters without whitespace',
    })
    expect(specs).toHaveLength(0)
  })

  it('reads no process environment: a name only the process sets is not in the spawn environment', () => {
    const previous = { GIT_TRACE: process.env.GIT_TRACE, GIT_TRACE_SETUP: process.env.GIT_TRACE_SETUP }
    process.env.GIT_TRACE = '/tmp/process-trace'
    process.env.GIT_TRACE_SETUP = '1'
    try {
      const { runtime } = scripted({})
      const resolved = resolvedOf(resolveClone(inputs(runtime, { url: UNREACHED_URL, env: { PATH: '/usr/bin' } }).options, TEMPLATE))
      expect(Object.values(resolved.env)).not.toContain('/tmp/process-trace')
      // GIT_ENV always removes GIT_TRACE, so only a prefix-matched name shows a process read: GIT_TRACE_SETUP.
      expect(Object.hasOwn(resolved.env, 'GIT_TRACE_SETUP'), 'GIT_TRACE_SETUP').toBe(false)
    } finally {
      restoreEnv(previous)
    }
  })
})

describe('the clone template', () => {
  /**
   * A provider that reads the template the spawn names, while git would be running.
   * @param inner - the provider that records the spawn.
   * @param seen - receives the template's directory and the text of its attributes file.
   * @returns the provider.
   */
  function watching(inner: SubprocessRuntime, seen: { directory?: string | undefined, attributes?: string | undefined }): SubprocessRuntime {
    return {
      spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
        const argument = spec.argv.find((value) => value.startsWith('--template='))
        seen.directory = argument?.slice('--template='.length)
        if (seen.directory !== undefined) seen.attributes = readFileSync(join(seen.directory, 'info', 'attributes'), 'utf8')
        return inner.spawn(spec)
      },
    } as SubprocessRuntime
  }

  it.each([['succeeds', 0], ['fails', 128]])('exists while git runs, with attributes that unset every filter, and is gone after a clone that %s', async (_label, exitCode) => {
    const seen: { directory?: string | undefined, attributes?: string | undefined } = {}
    await cloneRepository(inputs(watching(scripted({ exitCode }).runtime, seen), { url: UNREACHED_URL }).options)
    expect(seen.attributes).toBe('* -filter\n')
    expect(existsSync(seen.directory ?? scratch)).toBe(false)
  })

  it('is not made for a refused clone', async () => {
    const seen: { directory?: string | undefined, attributes?: string | undefined } = {}
    await cloneRepository(inputs(watching(scripted({}).runtime, seen), { url: 'http://127.0.0.1:1/owner/repo.git' }).options)
    expect(seen.directory).toBeUndefined()
  })

  it('removes .git/info/attributes from a clone that succeeded, and leaves a failed clone for the caller to remove', async () => {
    const plant = (runtime: SubprocessRuntime): SubprocessRuntime => ({
      spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
        mkdirSync(join(spec.cwd ?? scratch, '.git', 'info'), { recursive: true })
        writeFileSync(join(spec.cwd ?? scratch, '.git', 'info', 'attributes'), '* -filter\n')
        return runtime.spawn(spec)
      },
    }) as SubprocessRuntime
    const succeeded = await emptyDirectory()
    expect(await cloneRepository(inputs(plant(scripted({}).runtime), { url: UNREACHED_URL, directory: succeeded }).options)).toEqual({ ok: true })
    expect(existsSync(join(succeeded, '.git', 'info', 'attributes'))).toBe(false)
    const failed = await emptyDirectory()
    await cloneRepository(inputs(plant(scripted({ exitCode: 128 }).runtime), { url: UNREACHED_URL, directory: failed }).options)
    expect(existsSync(join(failed, '.git', 'info', 'attributes'))).toBe(true)
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

  it('removes the control characters of a line, except tab, before the line is cut to 300 characters', async () => {
    const progressLine = `${'\x01'.repeat(20)}${'p'.repeat(400)}`
    const { runtime } = scripted({ stderr: `Receiving\tobjects:\x07 50%\n${progressLine}\nfatal: a \x1b[31mbad\x00 value\n`, exitCode: 128 })
    const io = inputs(runtime, { url: UNREACHED_URL })
    expect(reasonOf(await cloneRepository(io.options))).toBe('git exited with code 128\nfatal: a [31mbad value')
    expect(io.progress).toEqual(['Receiving\tobjects: 50%', 'p'.repeat(300)])
  })

  it.each([
    ['a user name and password in a URL', 'https://user:delorun-test-password-not-a-secret@127.0.0.1:1/owner/repo.git', 'https://[redacted]@127.0.0.1:1/owner/repo.git'],
    ['an Authorization header', 'Authorization: Bearer shape-only-value', 'Authorization: Bearer [redacted]'],
    ['a credential-helper password line', 'password=shape-only-value', 'password=[redacted]'],
  ])('redacts %s from the reason and the progress lines, though the token is not in the output', async (_label, shape, redacted) => {
    const { runtime } = scripted({ stderr: `Receiving objects: 40% ${shape}\nfatal: could not use ${shape}\n`, exitCode: 128 })
    const io = inputs(runtime, { url: UNREACHED_URL })
    expect(reasonOf(await cloneRepository(io.options))).toBe(`git exited with code 128\nfatal: could not use ${redacted}`)
    expect(io.progress).toEqual([`Receiving objects: 40% ${redacted}`])
  })

  it('removes the token from a stream error that names it, so no warning holds it', async () => {
    const { runtime } = scripted({ failStderr: `read failed near ${TOKEN}`, exitCode: 0 })
    const io = inputs(runtime, { url: UNREACHED_URL, token: TOKEN })
    expect(await cloneRepository(io.options)).toEqual({ ok: true })
    expect(io.warnings).toEqual(['git clone: reading its error output failed: read failed near [redacted]'])
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

  it('ignores output that arrives after the clone has finished', async () => {
    const { runtime, streams } = scripted({ openStderr: true, exitCode: 0 })
    const io = inputs(runtime, { url: UNREACHED_URL })
    expect(await cloneRepository(io.options)).toEqual({ ok: true })
    streams[0]?.write('Receiving objects: 99% (late)\n')
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(io.progress).toEqual([])
  }, 15_000)

  it('drops a line whose length passes the limit across several chunks, and reads the next line', async () => {
    const { runtime } = scripted({ stderrChunks: [`fatal: ${'a'.repeat(5000)}`, `${'b'.repeat(5000)}\n`], stderr: 'Receiving objects: 9%\n', exitCode: 128 })
    const io = inputs(runtime, { url: UNREACHED_URL })
    expect(reasonOf(await cloneRepository(io.options))).toBe('git exited with code 128')
    expect(io.progress).toEqual(['Receiving objects: 9%'])
  })

  it('reads progress lines when the caller wants none', async () => {
    const { runtime } = scripted({ stderr: 'Receiving objects: 50%\nfatal: stopped\n', exitCode: 128 })
    expect(reasonOf(await cloneRepository(inputs(runtime, { url: UNREACHED_URL, onProgress: undefined }).options))).toBe('git exited with code 128\nfatal: stopped')
  })

  it('names a process that ended with neither an exit code nor a signal', async () => {
    const { runtime } = scripted({ endWithoutSignal: true })
    expect(reasonOf(await cloneRepository(inputs(runtime, { url: UNREACHED_URL }).options))).toBe('git was stopped by a signal')
  })

  it('reports a spawn that throws something other than an Error as the reason', async () => {
    const { runtime } = scripted({ throwValue: 'spawn refused' })
    expect(reasonOf(await cloneRepository(inputs(runtime, { url: UNREACHED_URL }).options))).toBe('git could not run: spawn refused')
  })
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
    expect(existsSync(join(directory, '.git', 'info', 'attributes'))).toBe(false)
  })

  it('runs no clean or smudge filter that a repository\'s .gitattributes names and a configuration defines', async () => {
    const source = join(scratch, 'filtered-source')
    const marker = join(scratch, 'filter-ran')
    const committer = ['-c', 'user.name=Spec', '-c', 'user.email=spec@example.invalid', '-c', 'commit.gpgsign=false']
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', source], { env: running().env, timeout: 30_000 })
    await writeFile(join(source, '.gitattributes'), '* filter=probe\n')
    await writeFile(join(source, 'file.txt'), 'content\n')
    execFileSync('git', ['-C', source, 'add', '.'], { env: running().env, timeout: 30_000 })
    execFileSync('git', ['-C', source, ...committer, 'commit', '--quiet', '-m', 'filtered'], { env: running().env, timeout: 30_000 })
    // The probe filter and the redirect to the local repository come from a person's configuration, here as options placed last.
    const configuration = ['-c', `filter.probe.smudge=sh -c 'touch "${marker}"; cat'`, '-c', 'filter.probe.clean=cat', '-c', 'filter.probe.required=false']
    const redirected = [...configuration, '-c', 'protocol.file.allow=always', '-c', `url.${source}.insteadOf=${running().origin}/public.git`]
    const withPersonConfig = (runtime: SubprocessRuntime): SubprocessRuntime => ({
      spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
        const at = spec.argv.indexOf('clone')
        return runtime.spawn({ ...spec, argv: [...spec.argv.slice(0, at), ...redirected, ...spec.argv.slice(at)] })
      },
    }) as SubprocessRuntime
    // Without the template the same configuration runs the filter, which shows the probe is able to fire.
    const control = join(scratch, 'control')
    execFileSync('git', [...configuration, 'clone', '--quiet', source, control], { env: running().env, timeout: 30_000 })
    expect(existsSync(marker)).toBe(true)
    await rm(marker)
    const directory = await emptyDirectory()
    const { origin } = running()
    expect(await cloneRepository(inputs(withPersonConfig(nodeRuntime()), { url: `${origin}/public.git`, directory }).options)).toEqual({ ok: true })
    expect(await readFile(join(directory, 'file.txt'), 'utf8')).toBe('content\n')
    expect(existsSync(marker)).toBe(false)
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

  it('never runs the askpass program of the person\'s configuration, even when a redirect asks for the token', async () => {
    const directory = await emptyDirectory()
    const { origin, caFile, password, home } = running()
    const marker = join(scratch, 'askpass-ran')
    const program = join(scratch, 'askpass.sh')
    await writeFile(program, `#!/bin/sh\nprintf 'ran, token %s\\n' "\${DELORUN_GIT_TOKEN:+present}" > '${marker}'\nexit 1\n`, { mode: 0o755 })
    const configPath = join(home, '.gitconfig')
    await writeFile(configPath, `[core]\n\taskPass = ${program}\n`)
    try {
      const result = await cloneRepository(inputs(nodeRuntime(), { url: `${origin}/moved.git`, directory, extraCaFile: caFile, token: password }).options)
      expect(result.ok).toBe(false)
      expect(await readFile(marker, 'utf8').catch(() => undefined)).toBeUndefined()
    } finally {
      await rm(configPath, { force: true })
    }
  })

  it('answers the token only over https, for the clone URL host and path', () => {
    const { origin, password } = running()
    const invocation = tokenGit(`${origin}/private.git`, password)
    const env = applyEnv(running().env, invocation.env)
    const host = new URL(origin).host
    const ask = (input: string): string => spawnSync('git', [...invocation.options, 'credential', 'fill'], { env, input, encoding: 'utf8', timeout: 30_000 }).stdout
    expect(ask(`protocol=https\nhost=${host}\npath=private.git\n\n`)).toContain(`password=${password}`)
    expect(ask(`protocol=http\nhost=${host}\npath=private.git\n\n`)).not.toContain(password)
    expect(ask(`protocol=https\nhost=127.0.0.1:1\npath=private.git\n\n`)).not.toContain(password)
    expect(ask(`protocol=https\nhost=${host}\npath=other.git\n\n`)).not.toContain(password)
  })

  it('answers `get` only, and prints nothing on its output or error stream for `store` and `erase`', () => {
    const invocation = tokenGit('https://127.0.0.1:9/private.git', TOKEN)
    const helper = invocation.options.find((option) => option.startsWith('credential.helper=!'))?.slice('credential.helper=!'.length)
    if (helper === undefined) throw new Error('the token invocation has no credential helper')
    // git runs `sh -c '<snippet> <action>' '<snippet> <action>'`: the action follows the snippet, so the snippet's function receives it as $1.
    const ask = (action: string, input: string): { stdout: string, stderr: string, status: number | null } => {
      const script = `${helper} ${action}`
      const { stdout, stderr, status } = spawnSync('sh', ['-c', script, script], { env: applyEnv({ PATH: process.env.PATH }, invocation.env), input, encoding: 'utf8', timeout: 30_000 })
      return { stdout, stderr, status }
    }
    const request = 'protocol=https\nhost=127.0.0.1:9\npath=private.git\n'
    expect(ask('get', `${request}\n`)).toEqual({ stdout: `username=x-access-token\npassword=${TOKEN}\n`, stderr: '', status: 0 })
    expect(ask('store', `${request}username=x-access-token\npassword=${TOKEN}\n\n`)).toEqual({ stdout: '', stderr: '', status: 0 })
    expect(ask('erase', `${request}\n`)).toEqual({ stdout: '', stderr: '', status: 0 })
  })
})

describe('git over the local HTTPS fixture, with hostile surroundings', () => {
  it('reaches the named server, and hands the token to no helper but its own, whatever the ambient git configuration says', async () => {
    const directory = await emptyDirectory()
    const { origin, caFile, password, home, requests } = running()
    const marker = join(scratch, 'ambient-helper-input')
    const hostileGlobal = join(scratch, 'hostile-gitconfig')
    await writeFile(hostileGlobal, `[url "https://127.0.0.1:1/"]\n\tinsteadOf = ${origin}/\n[credential]\n\thelper = "!cat >> '${marker}'"\n`)
    await mkdir(join(home, '.config', 'git'), { recursive: true })
    await writeFile(join(home, '.config', 'git', 'config'), `[url "https://127.0.0.1:2/"]\n\tinsteadOf = ${origin}/\n`)
    const ambient = {
      ...running().env,
      GIT_CONFIG_GLOBAL: hostileGlobal,
      GIT_CONFIG_NOSYSTEM: '0',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'url.https://127.0.0.1:3/.insteadOf',
      GIT_CONFIG_VALUE_0: `${origin}/`,
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: `!cat >> '${marker}'`,
      GIT_CONFIG_PARAMETERS: `'credential.helper=!cat >> ${marker}'`,
    }
    const mark = requests.length
    try {
      const result = await cloneRepository(inputs(nodeRuntime(ambient), { url: `${origin}/private.git`, directory, extraCaFile: caFile, token: password, env: ambient }).options)
      expect(result).toEqual({ ok: true })
    } finally {
      await rm(join(home, '.config'), { recursive: true, force: true })
    }
    expect(requests.slice(mark).some((request) => request.path === '/private.git/info/refs' && request.credential)).toBe(true)
    expect(await readFile(marker, 'utf8').catch(() => undefined)).toBeUndefined()
  })

  describe('the environment git receives', () => {
    let shims = ''
    let dump = ''

    beforeEach(async () => {
      shims = join(scratch, 'shims')
      dump = join(scratch, 'git-environment')
      await mkdir(shims)
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 30_000 }).trim()
      await writeFile(join(shims, 'git'), `#!/bin/sh\nenv > '${dump}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 })
      await chmod(join(shims, 'git'), 0o755)
    })

    /**
     * Clone through a provider that gives git the scrubbed process environment and the spawn's entries, as the real provider does,
     * and report the environment git received.
     * @param overrides - the clone options the spec sets.
     * @returns the clone result and the environment names git saw.
     */
    async function cloneAndDump(overrides: Partial<CloneOptions>): Promise<{ readonly result: CloneResult, readonly seen: Record<string, string> }> {
      const base = { ...scrubbedParentEnv(), HOME: running().home, XDG_CONFIG_HOME: join(running().home, '.config'), PATH: `${shims}:${process.env.PATH ?? ''}` }
      const result = await cloneRepository(inputs(nodeRuntime(base), { directory: await emptyDirectory(), extraCaFile: running().caFile, env: process.env, ...overrides }).options)
      const lines = (await readFile(dump, 'utf8')).split('\n').filter((line) => line.includes('='))
      return { result, seen: Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])) }
    }

    it('holds no token, and none of the ambient git names, for a clone without a token', async () => {
      vi.stubEnv('DELORUN_GIT_TOKEN', 'ambient-token-not-a-credential')
      vi.stubEnv('GIT_ASKPASS', '/bin/ambient-askpass')
      vi.stubEnv('GIT_CONFIG_COUNT', '1')
      vi.stubEnv('GIT_CONFIG_KEY_0', 'core.pager')
      vi.stubEnv('GIT_CONFIG_VALUE_0', 'cat')
      vi.stubEnv('GIT_TRACE', '1')
      vi.stubEnv('GIT_TERMINAL_PROMPT', '1')
      const { result, seen } = await cloneAndDump({ url: `${running().origin}/public.git` })
      expect(result).toEqual({ ok: true })
      expect(Object.keys(seen).filter((name) => /^(DELORUN_GIT_|GIT_ASKPASS|GIT_TRACE)|^GIT_CONFIG_(COUNT|KEY|VALUE|PARAMETERS)/.test(name))).toEqual([])
      expect(seen).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' })
    })

    it('holds the token and the host and path it answers for, for a clone with a token', async () => {
      const { password, origin } = running()
      const { result, seen } = await cloneAndDump({ url: `${origin}/private.git`, token: password })
      expect(result).toEqual({ ok: true })
      expect(seen).toMatchObject({ DELORUN_GIT_TOKEN: password, DELORUN_GIT_HOST: new URL(origin).host, DELORUN_GIT_PATH: 'private.git' })
    })
  })

  it('refuses a target directory that holds a planted .git, and clones nothing into it', async () => {
    const directory = await emptyDirectory()
    await mkdir(join(directory, '.git'))
    const { origin, caFile } = running()
    const reason = reasonOf(await cloneRepository(inputs(nodeRuntime(), { url: `${origin}/public.git`, directory, extraCaFile: caFile }).options))
    expect(reason).toContain('already exists and is not an empty directory')
    expect(await readdir(directory)).toEqual(['.git'])
    expect(await readdir(join(directory, '.git'))).toEqual([])
  })

  it('clones a private repository whose URL spells the host in upper case, answering the host the URL parser lower-cases', async () => {
    const directory = await emptyDirectory()
    const { origin, caFile, password, requests } = running()
    const url = `https://LOCALHOST:${new URL(origin).port}/private.git`
    const mark = requests.length
    expect(await cloneRepository(inputs(nodeRuntime(), { url, directory, extraCaFile: caFile, token: password }).options)).toEqual({ ok: true })
    expect(requests.slice(mark).some((request) => request.path === '/private.git/info/refs' && request.credential)).toBe(true)
    expect(await readFile(join(directory, 'README.md'), 'utf8')).toContain('fixture')
  })

  it('does not send the token to a request for another path of the same host, which a redirect names', async () => {
    const directory = await emptyDirectory()
    const { origin, caFile, password, requests } = running()
    const mark = requests.length
    const reason = reasonOf(await cloneRepository(inputs(nodeRuntime(), { url: `${origin}/moved.git`, directory, extraCaFile: caFile, token: password }).options))
    expect(reason).toContain('fatal:')
    const sent = requests.slice(mark)
    expect(sent.some((request) => request.path.startsWith('/private.git'))).toBe(true)
    expect(sent.filter((request) => request.credential)).toEqual([])
  })
})

describe('git over servers that redirect a clone', () => {
  let redirects: RedirectFixture

  beforeAll(async () => {
    redirects = await startRedirectFixture()
  }, 60_000)

  afterAll(async () => {
    await redirects.close()
  })

  it('does not send the credential across a redirect to another host, though the token would authenticate there', async () => {
    const directory = await emptyDirectory()
    const io = inputs(nodeRuntime(), { url: `${redirects.firstOrigin}/private.git`, directory, extraCaFile: redirects.caFile, token: redirects.targetPassword })
    const reason = reasonOf(await cloneRepository(io.options))
    expect(reason).toContain('fatal:')
    const basic = `Basic ${Buffer.from(`x-access-token:${redirects.targetPassword}`).toString('base64')}`
    expect(redirects.first.some((request) => request.authorization === basic)).toBe(true)
    expect(redirects.target.length).toBeGreaterThan(0)
    expect(redirects.target.filter((request) => request.authorization !== null)).toEqual([])
    expect([reason, ...io.progress, ...io.warnings].join('\n')).not.toContain(redirects.targetPassword)
  })

  it('refuses a redirect to a file:// URL and reads nothing from the file', async () => {
    const directory = await emptyDirectory()
    const reason = reasonOf(await cloneRepository(inputs(nodeRuntime(), { url: `${redirects.fileOrigin}/repository.git`, directory, extraCaFile: redirects.caFile }).options))
    expect(redirects.fileRequests()).toBeGreaterThan(0)
    expect(reason).toContain('fatal:')
    expect(reason).not.toContain('CANARY-NOT-A-REPOSITORY')
    expect(await readdir(directory)).toEqual([])
  })
})

describe('the process environment', () => {
  it('keeps HOME and XDG_CONFIG_HOME as the process had them, because the specs pass their environment explicitly', () => {
    expect(process.env.HOME).toBe(homeAtLoad)
    expect(process.env.XDG_CONFIG_HOME).toBe(xdgConfigHomeAtLoad)
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
 * The clone inputs for one spec, rooted in its scratch directory, with the fixture environment as the parent environment.
 * @param subprocess - the provider the spec runs git through.
 * @param overrides - the options the spec sets.
 * @returns the options and the lists the clone's warnings and progress lines go to.
 */
function inputs(subprocess: SubprocessRuntime, overrides: Partial<CloneOptions>): Inputs {
  const warnings: string[] = []
  const progress: string[] = []
  const options: CloneOptions = {
    subprocess,
    env: running().env,
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
 * The resolved spawn of a clone that the spec expects to resolve.
 * @param spec - the resolution.
 * @returns the spawn.
 * @throws Error when the clone was refused.
 */
function resolvedOf(spec: CloneSpec): Extract<CloneSpec, { readonly ok: true }> {
  if (!spec.ok) throw new Error(`expected the clone to resolve, saw the refusal: ${spec.reason}`)
  return spec
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
 * @returns the provider, the recorded spawns, and the error streams it handed out.
 */
function scripted(script: Script): { readonly runtime: SubprocessRuntime, readonly specs: SubprocessSpawnSpec[], readonly streams: PassThrough[] } {
  const specs: SubprocessSpawnSpec[] = []
  const streams: PassThrough[] = []
  const runtime = {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      specs.push(spec)
      if (script.throwOnSpawn !== undefined) throw new Error(script.throwOnSpawn)
      if (script.throwValue !== undefined) throw script.throwValue
      const stderr = script.noErrorPipe === true ? undefined : errorStream(script)
      if (stderr !== undefined) streams.push(stderr)
      return handleOf(stderr, outcomeOf(script, spec), () => undefined)
    },
  } as SubprocessRuntime
  return { runtime, specs, streams }
}

/**
 * The error stream a scripted process writes.
 * @param script - the text to write, and whether the stream stays open.
 * @returns the stream.
 */
function errorStream(script: Script): PassThrough {
  const stream = new PassThrough()
  const chunks = script.stderrChunks
  if (chunks !== undefined) {
    // Written once the reader's `data` listener has started the flow, so each write arrives as its own chunk; text
    // buffered before the reader's `setEncoding` would be joined into one.
    stream.once('resume', () => {
      for (const chunk of chunks) stream.write(chunk)
      stream.end(script.stderr ?? '')
    })
    return stream
  }
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
      const terminated = (): void => { resolve({ exitCode: null, signal: 'SIGTERM' }) }
      if (spec.signal?.aborted === true) terminated()
      else spec.signal?.addEventListener('abort', terminated, { once: true })
    })
  }
  if (script.endWithoutSignal === true) return Promise.resolve({ exitCode: null, signal: null })
  return Promise.resolve({ exitCode: script.exitCode ?? 0, signal: null })
}

/**
 * A subprocess provider over node:child_process, for the specs that run git.
 * Each spawn starts from the fixture environment, which stands for the provider's
 * scrubbed base, and leads its own process group: stopping the spawn also stops
 * the helper processes git starts.
 * @param base - the environment each spawn starts from; the fixture environment by default.
 * @returns the provider.
 */
function nodeRuntime(base: NodeJS.ProcessEnv = running().env): SubprocessRuntime {
  return {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      const [program = '', ...args] = spec.argv
      const child = spawn(program, args, { cwd: spec.cwd, env: applyEnv(base, spec.env ?? {}), detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
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
 * Run git for a check of the clone's result, in the fixture environment.
 * @param args - the arguments after `git`.
 * @returns the standard output without its final newline.
 */
function gitOut(args: readonly string[]): string {
  return execFileSync('git', [...args], { env: running().env, encoding: 'utf8', timeout: 30_000 }).trim()
}
