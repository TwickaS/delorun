/**
 * Integration tests: the REAL local subprocess service plus the PACKAGED
 * ripgrep binary (`@vscode/ripgrep`), exercised through `executeToolFixture()`.
 * These verify the WORLD — actual files on disk are discovered and grepped,
 * hostile patterns stay inert (they are plain argv elements; there is no
 * shell layer to escape), and real `rg` stderr classifies into the
 * `SEARCH_*` vocabulary. The binary ships inside the npm dependency, so the
 * suite runs on every platform without a system `rg` install; the
 * fake-service suite (tools.spec.ts) carries the coverage gate.
 */
import { executeModelToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync, symlinkSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, ProtectedReads, RunnerFailureRule, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

const testToolSignal = new AbortController().signal

let dir: string
let ctx: Context

let callCounter = 0
function call(name: string, args: unknown, agentObj?: object) {
  return executeToolFixture(ctx, {
    signal: testToolSignal,
    callId: ToolCallId(`it-${++callCounter}`),
    name,
    arguments: args,
    ...agentObj ? { agent: agentObj as never } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

/** The fixture workspace as a session cwd, so relative paths resolve inside `dir`. */
const agent = () => ({ session: { header: { id: 'session-int', cwd: dir } } })

describe('search tools over the real subprocess service + the packaged rg', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-search-int-'))
    await mkdir(join(dir, 'src'), { recursive: true })
    await mkdir(join(dir, '.git'), { recursive: true })
    await mkdir(join(dir, 'spaced dir'), { recursive: true })
    await writeFile(join(dir, 'src', 'alpha.ts'), 'export const alpha = 1\n// TODO: refit alpha\n')
    await writeFile(join(dir, 'src', 'beta.ts'), 'export const beta = 2\n')
    await writeFile(join(dir, 'notes.md'), 'alpha appears here too\n')
    await writeFile(join(dir, '.hidden.ts'), 'export const hidden = 3\n')
    await writeFile(join(dir, '.git', 'config.ts'), 'never listed\n')
    await writeFile(join(dir, 'spaced dir', "wei'rd name.ts"), 'const inside = true\n')
    // Deterministic --sort=modified order: alpha oldest, beta newest.
    await utimes(join(dir, 'src', 'alpha.ts'), new Date(2000, 0, 1), new Date(2000, 0, 1))
    await utimes(join(dir, 'src', 'beta.ts'), new Date(2020, 0, 1), new Date(2020, 0, 1))

    ctx = new Context()

    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  describe('glob', () => {
    it('prunes unrelated directories and preserves workspace-relative results', async () => {
      await mkdir(join(dir, 'packages', 'core', 'src', 'nested'), { recursive: true })
      await writeFile(join(dir, 'packages', 'core', 'src', 'old.ts'), '')
      await writeFile(join(dir, 'packages', 'core', 'src', '.hidden.ts'), '')
      await writeFile(join(dir, 'packages', 'core', 'src', 'nested', 'other.ts'), '')
      await mkdir(join(dir, 'packages', 'src', 'core'), { recursive: true })
      await writeFile(join(dir, 'packages', 'src', 'core', 'other.ts'), '')
      await writeFile(join(dir, '.gitignore'), 'packages/\n')
      await utimes(join(dir, 'packages', 'core', 'src', 'old.ts'), new Date(2000, 0, 1), new Date(2000, 0, 1))
      const spawn = vi.spyOn(ctx.subprocess, 'spawn')
      const ensure = vi.spyOn(ctx.workingDirectory, 'ensure')
      const result = await call('glob', { pattern: 'packages/core/src/*.ts' }, agent())
      expect(ensure).toHaveBeenCalledTimes(1)
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected glob success')
      expect(result.value).toEqual({ root: '.', paths: [
        join('packages', 'core', 'src', 'old.ts'),
        join('packages', 'core', 'src', '.hidden.ts'),
      ] })
      expect(spawn.mock.calls[0]?.[0].argv.slice(3, 6)).toEqual([
        '--glob=!**', '--glob={packages,core,src}/', '--glob=packages/core/src/*.ts',
      ])
      expect(spawn.mock.calls[0]?.[0].argv).not.toContain('--')
    })

    it.each(['*.ts', '**/*.ts', 'src/**/*.ts', '!src/*.ts', './src/*.ts', 'src/../src/*.ts', '.git/*.ts'])(
      'keeps the original traversal for %s', async (pattern) => {
        const spawn = vi.spyOn(ctx.subprocess, 'spawn')
        const result = await call('glob', { pattern }, agent())
        expect(result.isError).toBe(false)
        expect(spawn.mock.calls[0]?.[0].argv).not.toContain('--glob=!**')
      },
    )

    it.each(['missing/*.ts', 'notes.md/*.ts', 'src/alpha.ts/*.ts'])('reports no matches when a literal prefix names a missing directory or file: %s', async (pattern) => {
      const result = await call('glob', { pattern }, agent())
      expect(result.isError).toBe(false)
      expect(text(result)).toBe('No files found')
    })

    it.each([[1, 8170, 8192], [1, 8171, 0], [1500, 1, 23], [16, 240, 262]])('keeps %i directories of length %i searchable through Native execution', async (depth, length, pruningBytes) => {
      const pattern = `${Array.from({ length: depth }, () => 'a'.repeat(length)).join('/')}/*.ts`
      const spawn = vi.spyOn(ctx.subprocess, 'spawn')
      const result = await executeModelToolFixture(ctx, {
        signal: testToolSignal,
        callId: ToolCallId(`deep-glob-${++callCounter}`),
        name: 'glob',
        arguments: { pattern },
        agent: agent() as never,
      })
      expect(result.isError).toBe(false)
      expect(text(result)).toBe('No files found')
      const argv = spawn.mock.calls[0]?.[0].argv ?? []
      const pruning = argv.slice(3, argv.indexOf(`--glob=${pattern}`))
      expect(pruning.reduce((bytes, arg) => bytes + Buffer.byteLength(arg) + 1, 0)).toBe(pruningBytes)
    })

    it('preserves case-sensitive matching while pruning directories', async () => {
      const spawn = vi.spyOn(ctx.subprocess, 'spawn')
      expect(text(await call('glob', { pattern: 'SRC/*.ts' }, agent()))).toBe('No files found')
      expect(spawn.mock.calls[0]?.[0].argv).toContain('--glob={SRC}/')
    })

    it('prunes without adding a search root or following a directory link', async () => {
      await mkdir(join(dir, 'src', 'nested'))
      await writeFile(join(dir, 'src', 'nested', 'file.ts'), '')
      await symlink(join(dir, 'src'), join(dir, 'linked'), 'junction')
      const spawn = vi.spyOn(ctx.subprocess, 'spawn')
      expect(text(await call('glob', { pattern: 'linked/nested/*.ts' }, agent()))).toBe('No files found')
      expect(spawn.mock.calls[0]?.[0].argv).not.toContain('--')
    })

    it('discovers files by pattern, sorted by modification time, hidden included, .git excluded', async () => {
      const result = await call('glob', { pattern: '**/*.ts' }, agent())
      expect(result.isError).toBe(false)
      const paths = text(result).split('\n')
      expect(paths.indexOf(join('src', 'alpha.ts'))).toBeLessThan(paths.indexOf(join('src', 'beta.ts')))
      expect(paths).toContain('.hidden.ts')
      expect(paths).toContain(join('spaced dir', "wei'rd name.ts"))
      expect(paths).not.toContain(join('.git', 'config.ts'))
      expect(paths).not.toContain('notes.md')
    })

    it('scopes to a directory search root (path arg)', async () => {
      const result = await call('glob', { pattern: '*.ts', path: 'src' }, agent())
      expect(text(result).split('\n').sort()).toEqual([join('src', 'alpha.ts'), join('src', 'beta.ts')])
    })

    it('keeps an explicit path as the only search root when the pattern has a literal prefix', async () => {
      const spawn = vi.spyOn(ctx.subprocess, 'spawn')
      const result = await call('glob', { pattern: 'src/*.ts', path: '.' }, agent())
      expect(result.isError).toBe(false)
      expect(text(result).split('\n')).toEqual(['alpha.ts', 'beta.ts'].map(name => `.${sep}${join('src', name)}`))
      const argv = spawn.mock.calls[0]?.[0].argv
      expect(argv?.filter(part => part === '--')).toHaveLength(1)
      expect(argv?.slice(-2)).toEqual(['--', '.'])
      expect(argv).not.toContain('--glob=!**')
    })

    it('discovers files in a directory named dash without treating it as stdin', async () => {
      await mkdir(join(dir, '-'))
      await writeFile(join(dir, '-', 'file.ts'), '')
      const spawn = vi.spyOn(ctx.subprocess, 'spawn')
      const result = await call('glob', { pattern: '-/*.ts' }, agent())
      expect(result.isError).toBe(false)
      expect(text(result)).toBe(join('-', 'file.ts'))
      expect(spawn.mock.calls[0]?.[0].argv).not.toContain('--')
    })

    it('reports zero discoveries as No files found', async () => {
      expect(text(await call('glob', { pattern: '*.nomatch' }, agent()))).toBe('No files found')
    })

    it('excludes VCS internals even when the search root IS the VCS directory', async () => {
      // The prune glob alone never matches root-prefixed paths when rg is
      // rooted at .git; the paired contents glob keeps the exclusion airtight.
      expect(text(await call('glob', { pattern: '*', path: '.git' }, agent()))).toBe('No files found')
    })

    it('classifies an invalid glob as SEARCH_INVALID_PATTERN', async () => {
      const result = await call('glob', { pattern: '[' }, agent())
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { name: 'SearchError', code: 'SEARCH_INVALID_PATTERN' } })
    })
  })

  describe('grep', () => {
    it.each([undefined, ''])('greps without a file filter when include is %j', async (include) => {
      const result = await call('grep', { pattern: 'alpha', ...include !== undefined ? { include } : {} }, agent())
      expect(result.isError).toBe(false)
      const output = text(result)
      expect(output).toContain('Found 3 matches')
      expect(output).toContain(`${join('src', 'alpha.ts')}\nLine 1: export const alpha = 1\nLine 2: // TODO: refit alpha`)
      expect(output).toContain('notes.md\nLine 1: alpha appears here too')
    })

    it('greps a single FILE target', async () => {
      const result = await call('grep', { pattern: 'alpha', path: 'notes.md' }, agent())
      expect(text(result)).toBe('Found 1 match\n\nnotes.md\nLine 1: alpha appears here too')
    })

    it('greps a directory target with an include filter', async () => {
      const result = await call('grep', { pattern: 'alpha', path: '.', include: '*.ts' }, agent())
      const output = text(result)
      expect(output).toContain('alpha.ts')
      expect(output).not.toContain('notes.md')
    })

    it('a hostile pattern stays inert (a plain argv element, the world untouched)', async () => {
      // There is no shell layer between the argv vector and rg, so the pattern
      // is a literal regex — but the world-untouched guarantee is the shipped
      // contract, and a future shell-wrapping change must not reintroduce it.
      // The canary name carries no path so the regex stays valid on every
      // platform (a Windows path's backslashes would be regex escapes).
      const canary = join(dir, 'pwned')
      const result = await call('grep', { pattern: '$(touch pwned)' }, agent())
      expect(result.isError).toBe(false) // exit 1: found nothing, executed nothing
      expect(text(result)).toBe('No matches found')
      expect(existsSync(canary)).toBe(false)
    })

    it('a leading-dash pattern is a pattern, not a flag', async () => {
      await writeFile(join(dir, 'dashes.txt'), 'value --flag value\n')
      const result = await call('grep', { pattern: '--flag', path: 'dashes.txt' }, agent())
      expect(text(result)).toBe('Found 1 match\n\ndashes.txt\nLine 1: value --flag value')
    })

    it('classifies a real rg regex error as SEARCH_INVALID_PATTERN', async () => {
      const result = await call('grep', { pattern: '(unclosed' })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'SEARCH_INVALID_PATTERN' } })
    })

    it('classifies a missing target as SEARCH_FAILED', async () => {
      const result = await call('grep', { pattern: 'x', path: 'no-such-dir' })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'SEARCH_FAILED' } })
    })
  })

  describe('per-session cwd', () => {
    it('resolves the search in the SESSION workspace, not the process cwd', async () => {
      const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-search-session-'))
      try {
        await writeFile(join(sessionDir, 'only-here.ts'), 'const sessionFile = true\n')
        const agentObj = { session: { header: { id: 'session-int', cwd: sessionDir } } }
        const globbed = await call('glob', { pattern: '*.ts' }, agentObj)
        expect(text(globbed)).toBe('only-here.ts')
        const grepped = await call('grep', { pattern: 'sessionFile' }, agentObj)
        expect(text(grepped)).toContain('only-here.ts\nLine 1: const sessionFile = true')
      } finally {
        await rm(sessionDir, { recursive: true, force: true })
      }
    })
  })

  describe('pre-dispatch cancellation and spawn failures', () => {
    it('a pre-aborted registry call is ABORTED_BEFORE_DISPATCH', async () => {
      const controller = new AbortController()
      controller.abort()
      const result = await executeToolFixture(ctx, {
        callId: ToolCallId(`it-${++callCounter}`),
        name: 'grep',
        arguments: { pattern: 'x' },
        signal: controller.signal,
      })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH } })
    })

    it.each(['*', 'src/*.ts'])('an unusable session cwd provider rejection is SEARCH_FAILED for %s', async (pattern) => {
      const gone = join(dir, 'deleted-session-dir')
      const result = await call('glob', { pattern }, { session: { header: { id: 'session-int', cwd: gone } } })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { name: 'SearchError', code: 'SEARCH_FAILED' } })
      expect(text(result)).toContain('subprocess failed before reporting an outcome')
      expect(text(result)).not.toContain('could not start')
    })
  })
})

/**
 * A sandbox provider stand-in that reports protected reads and records each wrap. Its wrap enforces nothing: it runs
 * the argv behind {@link ProtectingProvider.runner}, so the tests see what the search tools ask the sandbox for.
 */
class ProtectingProvider extends SandboxProvider {
  static reads: ProtectedReads | undefined
  static wraps: { argv: readonly string[]; policy: SandboxPolicy }[] = []
  static runner: readonly string[] = []
  static rules: readonly RunnerFailureRule[] = []
  override get protectedReads(): ProtectedReads | undefined {
    return ProtectingProvider.reads
  }
  confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> {
    ProtectingProvider.wraps.push({ argv, policy })
    return Promise.resolve({ argv: [...ProtectingProvider.runner, ...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: ProtectingProvider.rules })
  }
}

describe('search tools and the sandbox provider\'s protected home', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-search-protected-'))
    const home = join(dir, '.delorun')
    await mkdir(join(home, 'secrets'), { recursive: true })
    await mkdir(join(home, 'runtimes'), { recursive: true })
    await mkdir(join(dir, 'sub'))
    await mkdir(join(dir, 'other-mount', 'secrets'), { recursive: true })
    await writeFile(join(home, 'secrets', 'key.txt'), 'needle secret\n')
    await writeFile(join(dir, 'other-mount', 'secrets', 'key.txt'), 'needle secret\n')
    await writeFile(join(home, 'runtimes', 'tool.txt'), 'needle runtime\n')
    await writeFile(join(dir, 'sub', 'work.txt'), 'needle work\n')
    await symlink(home, join(dir, 'home-link'), 'dir')
    const canonical = await realpath(dir)
    ProtectingProvider.reads = {
      roots: [join(canonical, '.delorun'), join(canonical, 'other-mount')],
      readable: [join(canonical, '.delorun', 'runtimes'), join(canonical, 'other-mount', 'runtimes')],
    }
    ProtectingProvider.wraps = []
    ProtectingProvider.runner = []
    ProtectingProvider.rules = []
    ctx = new Context()
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(ProtectingProvider)
    // The row names no fence setting: the provider's protected reads alone decide the refusal.
    await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('glob and grep over a workspace that contains the home leave out protected paths and keep readable entries', async () => {
    const globbed = text(await call('glob', { pattern: '**/*.txt' }, agent()))
    expect(globbed).toContain(join('sub', 'work.txt'))
    expect(globbed).toContain(join('.delorun', 'runtimes', 'tool.txt'))
    expect(globbed).not.toContain('key.txt')
    expect(globbed).not.toContain('other-mount')
    // grep skips hidden directories, so the visible stand-in for another mount of the home shows the filter.
    const grepped = text(await call('grep', { pattern: 'needle' }, agent()))
    expect(grepped).toContain('needle work')
    expect(grepped).not.toContain('needle secret')
    expect(grepped).not.toContain('other-mount')
    expect(text(await call('grep', { pattern: 'needle', path: '.delorun/runtimes' }, agent()))).toContain('needle runtime')
  })

  it.each(['.delorun', '.delorun/secrets', 'home-link', 'sub/../.delorun', 'other-mount'])('refuses glob and grep rooted at %s', async (path) => {
    for (const [name, args] of [['glob', { pattern: '**/*', path }], ['grep', { pattern: 'needle', path }]] as const) {
      const result = await call(name, args, agent())
      expect(result).toMatchObject({ isError: true, error: { info: { code: 'SEARCH_SANDBOX_DENIED' } } })
      expect(text(result)).not.toContain('needle secret')
    }
  })

  it('runs ripgrep confined read-only over the canonical root, not the model\'s spelling of it', async () => {
    const canonical = await realpath(dir)
    await mkdir(join(dir, 'real'))
    await writeFile(join(dir, 'real', 'linked.txt'), 'needle linked\n')
    await symlink(join(dir, 'real'), join(dir, 'work-link'), 'dir')
    const grepped = text(await call('grep', { pattern: 'needle', path: 'work-link' }, agent()))
    expect(grepped).toContain(`${join('work-link', 'linked.txt')}\nLine 1: needle linked`)
    const globbed = text(await call('glob', { pattern: '**/*.txt' }, agent()))
    expect(globbed).toContain(join('sub', 'work.txt'))
    expect(ProtectingProvider.wraps.map(wrap => wrap.policy)).toEqual([
      { mode: 'read-only', workspaceRoot: dir },
      { mode: 'read-only', workspaceRoot: dir },
    ])
    expect(ProtectingProvider.wraps[0]?.argv.at(-1)).toBe(join(canonical, 'real'))
    expect(ProtectingProvider.wraps[0]?.argv).not.toContain('work-link')
  })

  it('refuses a search whose root resolves to the home once ripgrep finishes', async () => {
    await mkdir(join(dir, 'flip'))
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const handle = spawn(spec)
      void handle.done.then(() => {
        rmSync(join(dir, 'flip'), { recursive: true })
        symlinkSync(join(dir, '.delorun'), join(dir, 'flip'), 'dir')
      })
      return handle
    })
    const result = await call('grep', { pattern: 'needle', path: 'flip' }, agent())
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'SEARCH_SANDBOX_DENIED' } } })
    expect(text(result)).toContain('the search root changed while the search ran')
  })

  it.skipIf(process.platform === 'win32')('fails a search whose sandbox runner fails instead of reporting no matches', async () => {
    ProtectingProvider.runner = ['sh', '-c', 'echo "stand-in-runner: cannot start" >&2; exit 1', 'sh']
    ProtectingProvider.rules = [{ fatalSignatures: ['stand-in-runner: '] }]
    const result = await call('grep', { pattern: 'needle' }, agent())
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'SEARCH_FAILED' } } })
    expect(text(result)).toContain('the sandbox runner failed')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports the rest of a search whose runner refuses to open the protected paths', async () => {
    // A directory the operating system refuses to open stands in for Landlock's and Seatbelt's refusal of the home.
    await chmod(join(dir, '.delorun', 'secrets'), 0o000)
    await chmod(join(dir, 'other-mount'), 0o000)
    try {
      const grepped = await call('grep', { pattern: 'needle', path: dir }, agent())
      expect(grepped.isError).not.toBe(true)
      expect(text(grepped)).toContain('needle work')
      await mkdir(join(dir, 'sub', 'locked'))
      await chmod(join(dir, 'sub', 'locked'), 0o000)
      const failed = await call('grep', { pattern: 'needle', path: dir }, agent())
      expect(failed).toMatchObject({ isError: true, error: { info: { code: 'SEARCH_FAILED' } } })
      await chmod(join(dir, 'sub', 'locked'), 0o755)
    } finally {
      await chmod(join(dir, '.delorun', 'secrets'), 0o755)
      await chmod(join(dir, 'other-mount'), 0o755)
    }
  })

  it('searches its own session\'s spill directory unconfined, and refuses another session\'s', async () => {
    const own = join(dir, '.delorun', 'spill', 'session-session-int')
    const other = join(dir, '.delorun', 'spill', 'session-other')
    await mkdir(own, { recursive: true })
    await mkdir(other, { recursive: true })
    await writeFile(join(own, 'grep.txt'), 'needle spilled\n')
    await writeFile(join(other, 'grep.txt'), 'needle other chat\n')
    const canonical = await realpath(dir)
    ProtectingProvider.reads = { ...ProtectingProvider.reads!, toolReadable: [join(canonical, '.delorun', 'spill')] }
    ctx.provide('spillStore', { sessionDirectory: (id: string) => join(canonical, '.delorun', 'spill', `session-${id}`) } as never)
    expect(text(await call('grep', { pattern: 'needle', path: '.delorun/spill/session-session-int' }, agent()))).toContain('needle spilled')
    expect(ProtectingProvider.wraps).toEqual([])
    for (const path of ['.delorun/spill/session-other', '.delorun/spill']) {
      const result = await call('grep', { pattern: 'needle', path }, agent())
      expect(result).toMatchObject({ isError: true, error: { info: { code: 'SEARCH_SANDBOX_DENIED' } } })
      expect(text(result)).not.toContain('other chat')
    }
    const refused = await call('grep', { pattern: 'needle', path: '.delorun/secrets' }, agent())
    expect(refused).toMatchObject({ isError: true, error: { info: { code: 'SEARCH_SANDBOX_DENIED' } } })
  })

  it('refuses a search rooted at a missing directory below a link to the home', async () => {
    for (const [name, args] of [['glob', { pattern: '**/*', path: 'home-link/not-yet' }], ['grep', { pattern: 'needle', path: 'home-link/not-yet/deeper' }]] as const) {
      const result = await call(name, args, agent())
      expect(result).toMatchObject({ isError: true, error: { info: { code: 'SEARCH_SANDBOX_DENIED' } } })
    }
    expect(ProtectingProvider.wraps).toEqual([])
  })

  it('refuses a search with no path in a session whose workspace is the home', async () => {
    const result = await call('glob', { pattern: '**/*' }, { session: { header: { id: 'session-home', cwd: join(dir, '.delorun') } } })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'SEARCH_SANDBOX_DENIED' } } })
    expect(text(result)).toContain('cannot search "."')
  })

  it('runs ripgrep under the session\'s network', async () => {
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: dir, network: { mode: 'off' } }) } as never)
    await call('glob', { pattern: '**/*.txt', path: 'sub' }, agent())
    expect(ProtectingProvider.wraps.map(wrap => wrap.policy)).toEqual([{ mode: 'read-only', workspaceRoot: dir, network: { mode: 'off' } }])
  })

  it('searches under the home in a session under danger-full-access', async () => {
    const modes: string[] = []
    ctx.provide('sandboxPolicy', { resolve: () => { modes.push('resolved'); return { mode: 'danger-full-access' } } } as never)
    expect(text(await call('grep', { pattern: 'needle', path: 'other-mount' }, agent()))).toContain('needle secret')
    expect(modes).toEqual(['resolved'])
    // An agentless call resolves the deployment's policy.
    await call('glob', { pattern: '**/*.txt', path: join(dir, 'sub') })
    expect(modes).toEqual(['resolved', 'resolved'])
  })

  it('searches under the home when the provider protects nothing', async () => {
    ProtectingProvider.reads = undefined
    expect(text(await call('grep', { pattern: 'needle', path: '.delorun' }, agent()))).toContain('needle secret')
  })
})

describe('search tools without a sandbox provider', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-search-no-provider-'))
    await mkdir(join(dir, '.delorun', 'secrets'), { recursive: true })
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, '.delorun', 'secrets', 'key.txt'), 'needle secret\n')
    await writeFile(join(dir, 'sub', 'work.txt'), 'needle work\n')
    ctx = new Context()
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(LocalSubprocessRuntime)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('searches everywhere the session reaches, because no provider reports a protected home', async () => {
    await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: false })
    expect(text(await call('glob', { pattern: '**/*.txt' }, agent()))).toContain(join('.delorun', 'secrets', 'key.txt'))
    expect(text(await call('grep', { pattern: 'needle', path: '.delorun' }, agent()))).toContain('needle secret')
    expect(text(await call('grep', { pattern: 'needle' }, agent()))).toContain('needle work')
  })
})
