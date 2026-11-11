/**
 * The protected home and the search tools of a Delo CLI profile. Every row of the composed profile that mounts
 * `@deepseek-ai/dsh-tool-fs-search`, the rows inside each agent preset included, is mounted with its composed config
 * beside upstream's local sandbox provider configured with the composed `sandbox` row, and `glob` and `grep` run over a
 * temporary Delo home. A search rooted under the home, or reaching it through a workspace link, is refused with
 * `SEARCH_SANDBOX_DENIED`; a wider search leaves the home's paths out and keeps C1's read exemptions; a search outside
 * the home is unchanged. With the sandbox row in its parity form, which leaves the row to upstream, the same rows search
 * the home as upstream's tools do.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { interpolate, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_ROWS } from '../src/profile.ts'
import { createTestHome, DELO_PROFILE, type TestHome } from './profiles.ts'

/** The module whose rows register `glob` and `grep`. */
const SEARCH_MODULE = '@deepseek-ai/dsh-tool-fs-search'

/** One composed row that mounts the search tools. */
interface SearchRow {
  /** The row's place in the composition: the ids from the top level down, such as `preset-standard/tool-fs-search`. */
  readonly path: string
  /** The row's composed config. */
  readonly config: Record<string, unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether a value is a loader entry: a mapping with a string `id` and `name`, as every composed row carries. */
const isEntry = (value: unknown): value is EntryOptions =>
  isRecord(value) && typeof value['id'] === 'string' && typeof value['name'] === 'string'

/**
 * The rows an entry mounts below it: a group's entries and an agent preset's plugin list.
 * @param entry - a composed entry.
 * @returns its child entries; none for a plain row.
 */
function children(entry: EntryOptions): EntryOptions[] {
  const config: unknown = entry.config
  if (Array.isArray(config)) return config.filter(isEntry)
  if (isRecord(config) && Array.isArray(config['plugins'])) return config['plugins'].filter(isEntry)
  return []
}

/**
 * Every row of a composition that can mount the search tools: each row naming {@link SEARCH_MODULE} under no row whose
 * `disabled` is literally `true`, at any depth.
 * @param entries - a composed entry list.
 * @param parent - the path of the entry that holds the list.
 * @returns the rows, in composition order.
 */
function searchRows(entries: readonly EntryOptions[], parent: string): SearchRow[] {
  return entries.flatMap((entry) => {
    if (entry.disabled === true) return []
    const path = parent === '' ? String(entry.id) : `${parent}/${String(entry.id)}`
    const own = entry.name === SEARCH_MODULE ? [{ path, config: isRecord(entry.config) ? entry.config : {} }] : []
    return [...own, ...searchRows(children(entry), path)]
  })
}

/** The temporary Harness home, which is the Delo home of the composition's `sandbox` row. */
const base = mkdtempSync(join(tmpdir(), 'delo-protected-reads-'))
const home: TestHome = createTestHome(base)
const workspace = join(base, 'work')
const composed = home.rows(DELO_PROFILE)
const rows = searchRows(composed, '')

mkdirSync(join(home.dir, 'secrets'))
writeFileSync(join(home.dir, 'secrets', 'key.txt'), 'needle secret\n')
writeFileSync(join(home.dir, '.credentials.yaml'), 'needle credential\n')
mkdirSync(join(home.dir, 'runtimes'))
writeFileSync(join(home.dir, 'runtimes', 'tool.txt'), 'needle runtime\n')
mkdirSync(workspace)
writeFileSync(join(workspace, 'notes.txt'), 'needle work\n')
symlinkSync(home.dir, join(workspace, 'home-link'), 'dir')
symlinkSync(join(home.dir, 'secrets'), join(workspace, 'secrets-link'), 'dir')

/**
 * The composed `sandbox` row's config, with its `!!js` values evaluated as the loader evaluates them in a runtime
 * process whose harness home is the temporary home.
 * @returns the provider config.
 */
function composedSandboxConfig(): Record<string, unknown> {
  const row = composed.find(entry => entry.id === 'sandbox')
  if (!isRecord(row?.config)) throw new Error('the composed Delo CLI profile has no configured sandbox row')
  const dshHomePath = (): string => home.dir
  const config: unknown = interpolate({ dshHomePath }, row.config)
  if (!isRecord(config)) throw new Error('the composed sandbox row\'s config is not a mapping')
  return config
}

let ctx: Context | undefined
let calls = 0

afterEach(async () => {
  vi.restoreAllMocks()
  await ctx?.fiber.dispose()
  ctx = undefined
})

afterAll(() => { rmSync(base, { recursive: true, force: true }) })

/**
 * Mount one search row's config beside the local sandbox provider, as the composed profile mounts it.
 * @param config - the search row's composed config.
 * @param sandbox - the sandbox row's config.
 */
async function mount(config: Record<string, unknown>, sandbox: Record<string, unknown>): Promise<void> {
  ctx = new Context()
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalSandboxProvider, sandbox)
  await ctx.plugin(ToolFsSearch, interpolate({}, config))
}

/**
 * Whether the local sandbox provider can confine a command on this host under the composed protection, which the
 * search tools need to run ripgrep under the protected home.
 * @returns true when a confined `true` exits 0.
 */
async function confinementUsable(): Promise<boolean> {
  const probe = new Context()
  await probe.plugin(LocalSandboxProvider, composedSandboxConfig())
  let argv: string[]
  try {
    argv = (await probe.sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: workspace })).argv
  } catch (error) {
    // SandboxUnavailableError: no runner can confine on this host, so the searches that run ripgrep are skipped.
    console.warn(`protected-reads: confinement unavailable: ${String(error)}`)
    return false
  } finally {
    await probe.fiber.dispose()
  }
  const [program, ...rest] = argv
  return program !== undefined && spawnSync(program, rest, { stdio: 'ignore', timeout: 30_000 }).status === 0
}

/** Whether searches under the protected home can run here; they fail closed where no runner can confine them. */
const CONFINED = await confinementUsable()

/** One finished tool call. */
interface CallResult {
  readonly isError?: boolean
  readonly text: string
  readonly code: unknown
}

/**
 * Call a search tool from a session whose workspace is {@link workspace}.
 * @param name - `glob` or `grep`.
 * @param args - the tool arguments.
 * @returns whether it failed, its text and its error code.
 */
async function call(name: 'glob' | 'grep', args: Record<string, unknown>): Promise<CallResult> {
  if (ctx === undefined) throw new Error('no composition is mounted')
  const result = await executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`protected-reads-${String(++calls)}`),
    name,
    arguments: args,
    agent: { session: { header: { id: 'session-protected-reads', cwd: workspace } } } as never,
  })
  const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  return { isError: result.isError, text, code: result.isError === true ? result.error?.info?.['code'] : undefined }
}

/** A search the protected home refuses, through each spelling a model can reach it by. */
const REFUSED: readonly (readonly ['glob' | 'grep', Record<string, unknown>])[] = [
  ['glob', { pattern: '**/*', path: home.dir }],
  ['grep', { pattern: 'needle', path: join(home.dir, 'secrets') }],
  ['glob', { pattern: '**/*', path: 'home-link' }],
  ['grep', { pattern: 'needle', path: 'home-link/secrets' }],
  ['grep', { pattern: 'needle', path: 'secrets-link' }],
  ['glob', { pattern: '*.txt', path: 'secrets-link' }],
]

describe('the composed Delo CLI profile', () => {
  it('mounts the search tools only from rows inside the agent presets', () => {
    // The web template disables the top-level row and each preset mounts its own, so a setting on the top-level row
    // reaches no model; the protection must hold without any setting on the rows below.
    expect(composed.find(entry => entry.id === 'tool-fs-search')?.disabled).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.path).toMatch(/^preset-[^/]+\/tool-fs-search$/)
  })

  it('protects the home on the sandbox row only, and leaves that row to upstream in the parity composition', () => {
    expect(composedSandboxConfig()).toMatchObject({ protectedHome: home.dir })
    expect(LOCAL_ROWS.map(row => row.id)).not.toContain('tool-fs-search')
    expect(LOCAL_ROWS.find(row => row.id === 'sandbox')?.parity.kind).toBe('upstream')
  })
})

describe.each(rows)('the search tools of $path', ({ config }) => {
  it.each(REFUSED)('refuse %s over %j with SEARCH_SANDBOX_DENIED', async (name, args) => {
    await mount(config, composedSandboxConfig())
    const result = await call(name, args)
    expect(result).toMatchObject({ isError: true, code: 'SEARCH_SANDBOX_DENIED' })
    expect(result.text).not.toContain('needle secret')
    expect(result.text).not.toContain('key.txt')
  })

  it.skipIf(!CONFINED)('leave the home\'s paths out of a wider search and keep the read exemptions and the workspace', async () => {
    await mount(config, composedSandboxConfig())
    const globbed = await call('glob', { pattern: '**/*', path: base })
    expect(globbed.isError).not.toBe(true)
    expect(globbed.text).toContain('notes.txt')
    expect(globbed.text).toContain(join('runtimes', 'tool.txt'))
    expect(globbed.text).not.toContain('key.txt')
    expect(globbed.text).not.toContain('.credentials.yaml')
    const grepped = await call('grep', { pattern: 'needle', path: base })
    expect(grepped.text).toContain('needle work')
    expect(grepped.text).toContain('needle runtime')
    expect(grepped.text).not.toContain('needle secret')
  })

  it('search their own session\'s spilled output under the home, and refuse another session\'s', async () => {
    await mount(config, composedSandboxConfig())
    if (ctx === undefined) throw new Error('no composition is mounted')
    const spill = join(realpathSync(home.dir), 'spill')
    for (const id of ['session-protected-reads', 'session-other']) {
      mkdirSync(join(spill, id), { recursive: true })
      writeFileSync(join(spill, id, 'grep.txt'), `needle spilled for ${id}\n`)
    }
    // A spill store keeping each session's artifacts in its own directory, as the local store does.
    ctx.provide('spillStore', { sessionDirectory: (id: string) => join(spill, id) } as never)
    const grepped = await call('grep', { pattern: 'needle', path: join(spill, 'session-protected-reads') })
    expect(grepped.isError).not.toBe(true)
    expect(grepped.text).toContain('needle spilled for session-protected-reads')
    expect((await call('glob', { pattern: '**/*.txt', path: join(spill, 'session-protected-reads') })).text).toContain('grep.txt')
    for (const path of [join(spill, 'session-other'), spill]) {
      const refused = await call('grep', { pattern: 'needle', path })
      expect(refused).toMatchObject({ isError: true, code: 'SEARCH_SANDBOX_DENIED' })
      expect(refused.text).not.toContain('session-other')
    }
  })

  it.skipIf(!CONFINED)('search the workspace as before', async () => {
    await mount(config, composedSandboxConfig())
    expect((await call('glob', { pattern: '*.txt' })).text).toContain('notes.txt')
    expect((await call('grep', { pattern: 'needle' })).text).toContain('needle work')
  })

  it.skipIf(!CONFINED)('keep the home unreadable when a workspace directory is replaced by a link to it while the search runs', async () => {
    await mount(config, composedSandboxConfig())
    if (ctx === undefined) throw new Error('no composition is mounted')
    const flip = join(workspace, 'flip')
    mkdirSync(flip)
    // The directory is a link to the home while ripgrep runs and a directory again before the tool checks its root.
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      rmSync(flip, { recursive: true })
      symlinkSync(home.dir, flip, 'dir')
      const handle = spawn(spec)
      void handle.done.then(() => {
        rmSync(flip)
        mkdirSync(flip)
      })
      return handle
    })
    try {
      for (const [name, args] of [['grep', { pattern: 'needle', path: 'flip' }], ['glob', { pattern: '**/*', path: 'flip' }]] as const) {
        const result = await call(name, args)
        expect(result.text).not.toContain('needle secret')
        expect(result.text).not.toContain('key.txt')
        expect(result.text).not.toContain('.credentials.yaml')
      }
    } finally {
      rmSync(flip, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('fail closed when no runner can confine the search', async () => {
    await mount(config, composedSandboxConfig())
    if (ctx === undefined) throw new Error('no composition is mounted')
    ;(ctx.sandbox as LocalSandboxProvider).internals = { platform: 'linux', probeBwrap: () => false, probeLandlock: () => 'unusable' }
    const result = await call('grep', { pattern: 'needle' })
    expect(result).toMatchObject({ isError: true, code: 'SEARCH_FAILED' })
    expect(result.text).toContain('could not be confined')
  })

  it('search the home as upstream\'s tools do with the sandbox row in its parity form', async () => {
    // The parity overlay leaves the sandbox row to upstream, which protects no home.
    await mount(config, {})
    expect((await call('glob', { pattern: '**/*', path: home.dir })).text).toContain(join('secrets', 'key.txt'))
    expect((await call('grep', { pattern: 'needle', path: join(home.dir, 'secrets') })).text).toContain('needle secret')
    expect((await call('grep', { pattern: 'needle', path: 'secrets-link' })).text).toContain('needle secret')
  })
})
