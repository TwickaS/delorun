/**
 * The one composition of a Host over a Delorun home (`delorun/apps/cli/src/compose.ts`) and its invariants. The specs set
 * up a real home with `delorun setup --yes`, compose its CLI profile with upstream's own profile preparation, and hold
 * the composed and the booted rows to the invariants: a layer that disables a Delorun row or the sandbox row, or turns a
 * prompt switch away from the recorded answer, refuses the start naming the file; a booted Host whose rows, sandbox
 * settings or services differ from the composition refuses; a required row that another layer inserts again, or that
 * runs another plugin, refuses; safe mode exempts no required row; the "Ask less" answer is honoured; and the
 * approved plugin content slot applies before the sandbox overlay.
 */
import { CLI_PROFILE } from '@delorun/contract-home-layout'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse, stringify } from 'yaml'
import { prepareHome, type CommandContext } from '../src/command.ts'
import { assertComposedInvariants, assertDelorunInvariants, composeDelorunProfile, composedRows, NO_APPROVED_CONTENT, ROW_SERVICES, TURN_GATE_SERVICE, type BootedHost, type ComposedStart, type ComposeKind, type ServiceProvider } from '../src/compose.ts'
import { OPT_IN_ROWS, type BootedRow } from '../src/delorun-bundles.ts'
import { CliError, EXIT } from '../src/exit.ts'
import { main } from '../src/main.ts'
import { composedRow, isRecord } from '../src/patch-layers.ts'
import { promptRows } from '../src/setup/prompt-switches.ts'
import { upstreamAddHeadlessBundle, upstreamDependencies } from '../src/start.ts'
import { HEADLESS_BUNDLE } from '@delorun/bundle-local/profile'

/** The rows of `@delorun/bundle-headless`. */
const HEADLESS_ROWS = ['delorun-instruction-consent', 'delorun-mcp-consent', 'delorun-schedule-consent', 'delorun-permission-defaults', 'delorun-plugin-changes', 'delorun-fetch-guard', 'delorun-delegation-consent', 'delorun-update-gate'] as const

/** The services the headless bundle's rows provide and the row each comes from. */
const HEADLESS_SERVICES = [
  ['fetchGuard', 'delorun-fetch-guard'],
  ['writeConsent', 'delorun-instruction-consent'],
  ['mcpAddConsent', 'delorun-mcp-consent'],
  ['scheduleConsent', 'delorun-schedule-consent'],
  ['sandboxModeGuard', 'delorun-permission-defaults'],
  ['delegationConsent', 'delorun-delegation-consent'],
  ['sandboxNetwork', 'delorun-permission-defaults'],
  [TURN_GATE_SERVICE, 'delorun-update-gate'],
] as const

let osHome: string
let delorunHome: string
let context: CommandContext

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-compose-')))
  delorunHome = join(osHome, '.delorun')
  vi.stubEnv('HOME', osHome)
  vi.stubEnv('USERPROFILE', osHome)
  vi.stubEnv('DSH_HOME', join(osHome, '.dsh'))
  vi.stubEnv('DELORUN_HOME', undefined)
  vi.stubEnv('DELORUN_PROFILE', undefined)
  context = { env: { HOME: osHome, DSH_HOME: join(osHome, '.dsh'), DEEPSEEK_API_KEY: 'fixture-key' }, stdout: () => undefined, stderr: () => undefined }
  expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
  await prepareHome(context, undefined)
}, 60_000)

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(osHome, { recursive: true, force: true })
})

/**
 * Compose the profile.
 * @param kind - the profile's kind.
 * @param profile - the profile's name.
 * @returns the composed start.
 */
async function compose(kind: ComposeKind = 'cli', profile = 'default'): Promise<ComposedStart> {
  return composeDelorunProfile({ home: delorunHome, profile, kind, output: context, env: {}, osHome }, { prepareProfile: upstreamDependencies().prepareProfile, approvedPluginContent: NO_APPROVED_CONTENT })
}

/**
 * Expect a composition or a check to refuse.
 * @param run - the composition or check.
 * @returns the refusal's message.
 */
async function refused(run: () => unknown): Promise<string> {
  const error: unknown = await Promise.resolve().then(run).then(() => undefined, (failure: unknown) => failure)
  expect(error).toBeInstanceOf(CliError)
  return (error as CliError).message
}

/**
 * Write a patch list.
 * @param path - the file.
 * @param patches - the patches.
 */
function writePatch(path: string, patches: readonly object[]): void {
  writeFileSync(path, stringify(patches))
}

/** The profile's own patch, with a patch appended. */
function appendToProfilePatch(patch: object): string {
  const path = join(delorunHome, 'profiles', 'default', 'cordis.patch.yml')
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n${stringify([patch])}`)
  return path
}

/**
 * A Host that mounted the composition, with rows replaced or added. Each required row's services are provided by that
 * row while it is enabled and its switch is not off, unless `providers` names the service.
 * @param composed - the composed start.
 * @param overrides - the rows to replace or add.
 * @param providers - providers that replace the default, by service; `undefined` for an absent service.
 * @returns the Host.
 */
function booted(composed: ComposedStart, overrides: readonly BootedRow[] = [], providers: Readonly<Record<string, ServiceProvider | undefined>> = {}): BootedHost {
  const rows = new Map(composedRows(composed).map(row => [row.id, row]))
  for (const row of overrides) rows.set(row.id, row)
  return {
    rows: () => [...rows.values()],
    providerOf: (name) => {
      if (name in providers) return providers[name]
      const owner = Object.entries(ROW_SERVICES).find(([, services]) => services.includes(name))?.[0]
      const row = owner === undefined ? undefined : rows.get(owner)
      if (owner === undefined || row === undefined || row.disabled || (isRecord(row.config) && row.config.enabled === false)) return undefined
      return { row: owner }
    },
  }
}

describe('a set-up CLI profile', { timeout: 60_000 }, () => {
  it('composes with the sandbox overlay last, requires the sandbox row and every Delorun row, and passes once booted as composed', async () => {
    const composed = await compose()
    expect(composed.patchFiles).toEqual([join(delorunHome, 'run', 'default', 'sandbox.patch.yml')])
    expect(composed.required).toEqual(expect.arrayContaining([
      { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local' },
      { id: 'delorun-privacy', name: '@delorun/bundle-local' },
      { id: 'delorun-fetch-guard', name: '@delorun/plugin-fetch-guard' },
      { id: 'delorun-update-gate', name: '@delorun/bundle-local/update-gate' },
      { id: 'delorun-mcp-consent', name: '@delorun/plugin-mcp-consent' },
    ]))
    expect(composed.prompts).toBe('safer')
    expect(() => { assertDelorunInvariants(composed, booted(composed)) }).not.toThrow()
  })

  it('refuses a home patch that disables the fetch guard, naming the file and the remedy', async () => {
    writePatch(join(delorunHome, 'cordis.patch.yml'), [{ id: 'delorun-fetch-guard', disabled: true }])
    const message = await refused(compose)
    expect(message).toContain(`delorun-fetch-guard is disabled (set in ${join(delorunHome, 'cordis.patch.yml')})`)
    expect(message).toContain('delorun recover safe-mode --profile default')
  })

  it('refuses a profile patch that disables the sandbox row or the update gate', async () => {
    const path = appendToProfilePatch({ id: 'sandbox', disabled: true })
    appendToProfilePatch({ id: 'delorun-update-gate', disabled: true })
    const message = await refused(compose)
    expect(message).toContain(`sandbox is disabled (set in ${path})`)
    expect(message).toContain('delorun-update-gate is disabled')
  })

  it('refuses a patch that turns a consent row to its parity value without the "Ask less" answer, and accepts it with that answer', async () => {
    writePatch(join(delorunHome, 'cordis.patch.yml'), [{ id: 'delorun-mcp-consent', config: { enabled: false } }])
    expect(await refused(compose)).toContain(`delorun-mcp-consent has enabled false, not true, which the recorded prompts answer "Ask me first" sets (set in ${join(delorunHome, 'cordis.patch.yml')})`)
    const answers = join(delorunHome, 'profiles', 'default', 'setup-answers.json')
    writeFileSync(answers, JSON.stringify({ ...JSON.parse(readFileSync(answers, 'utf8')) as object, prompts: 'stock' }))
    rmSync(join(delorunHome, 'cordis.patch.yml'))
    for (const row of promptRows('stock')) appendToProfilePatch({ id: row.id, config: row.config })
    appendToProfilePatch({ id: 'delorun-delegation-consent', config: { enabled: false } })
    const composed = await compose()
    expect(composed.prompts).toBe('stock')
    expect(() => { assertDelorunInvariants(composed, booted(composed)) }).not.toThrow()
  })

  it('refuses a patch that sets fullAccessEverywhere without the "Never ask (dangerous)" answer, naming the file, and accepts it with that answer', async () => {
    const path = appendToProfilePatch({ id: 'delorun-permission-defaults', config: { fullAccessEverywhere: true } })
    expect(await refused(compose)).toContain(`delorun-permission-defaults has fullAccessEverywhere true, not false, which the recorded prompts answer "Ask me first" sets (set in ${path})`)
    const answers = join(delorunHome, 'profiles', 'default', 'setup-answers.json')
    writeFileSync(answers, JSON.stringify({ ...JSON.parse(readFileSync(answers, 'utf8')) as object, prompts: 'dangerous' }))
    appendToProfilePatch({ id: 'delorun-instruction-consent', config: { enabled: false, approvedPluginWrites: false } })
    for (const id of ['delorun-mcp-consent', 'delorun-schedule-consent']) appendToProfilePatch({ id, config: { enabled: false } })
    appendToProfilePatch({ id: 'delorun-permission-defaults', config: { enabled: true, fullAccessEverywhere: true } })
    const composed = await compose()
    expect(composed.prompts).toBe('dangerous')
    expect(() => { assertDelorunInvariants(composed, booted(composed)) }).not.toThrow()
  })

  it('refuses a consent row left on when the recorded answer is "Ask less"', async () => {
    const answers = join(delorunHome, 'profiles', 'default', 'setup-answers.json')
    writeFileSync(answers, JSON.stringify({ ...JSON.parse(readFileSync(answers, 'utf8')) as object, prompts: 'stock' }))
    expect(await refused(compose)).toContain('which the recorded prompts answer "Ask less (like DeepSeek Harness)" sets')
  })

  it('reports a required row no layer inserts, and a profile preparation that throws a plain value', async () => {
    const composed = await compose()
    const ghost: ComposedStart = { ...composed, required: [...composed.required, { id: 'ghost', name: undefined }] }
    expect(composedRows(ghost).map(row => row.id)).not.toContain('ghost')
    expect(await refused(() => { assertComposedInvariants(ghost) })).toContain('ghost is not in the profile')
    expect(await refused(() => composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome }, { prepareProfile: () => Promise.reject('no manifest'), approvedPluginContent: NO_APPROVED_CONTENT }))).toContain('could not be loaded: no manifest')
  })

  it('refuses a fetch guard turned off whatever the answer', async () => {
    appendToProfilePatch({ id: 'delorun-fetch-guard', config: { enabled: false } })
    expect(await refused(compose)).toContain('delorun-fetch-guard has enabled false, not true, which stays on whatever the prompts answer')
  })
})

describe('a required row another layer replaces', { timeout: 60_000 }, () => {
  it('refuses a profile patch that inserts a second fetch guard row with another plugin, naming the file', async () => {
    const path = appendToProfilePatch({ insert: [{ id: 'delorun-fetch-guard', name: './allow-all.js', config: { enabled: true } }] })
    const local = pathToFileURL(join(delorunHome, 'profiles', 'default', 'allow-all.js')).href
    const message = await refused(compose)
    expect(message).toContain(`delorun-fetch-guard is inserted again, which would replace the plugin @delorun/plugin-fetch-guard, with "${local}" (set in ${path})`)
    expect(message).toContain(`delorun-fetch-guard runs the plugin "${local}", not @delorun/plugin-fetch-guard`)
  })

  it('refuses a home patch that inserts a second sandbox row, and an overlay that does', async () => {
    writePatch(join(delorunHome, 'cordis.patch.yml'), [{ insert: [{ id: 'sandbox', name: '@x/no-sandbox' }] }])
    expect(await refused(compose)).toContain(`sandbox is inserted again, which would replace the plugin @deepseek-ai/dsh-sandbox-local, with "@x/no-sandbox" (set in ${join(delorunHome, 'cordis.patch.yml')})`)
    rmSync(join(delorunHome, 'cordis.patch.yml'))
    const extra = join(osHome, 'shadow.patch.yml')
    writePatch(extra, [{ insert: [{ id: 'sandbox', name: '@x/no-sandbox' }] }])
    expect(await refused(() => composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome }, {
      prepareProfile: upstreamDependencies().prepareProfile,
      approvedPluginContent: () => Promise.resolve([extra]),
    }))).toContain(`sandbox is inserted again, which would replace the plugin @deepseek-ai/dsh-sandbox-local, with "@x/no-sandbox" (set in ${extra})`)
  })

  it('refuses a required row whose first insert is not its declaring bundle\'s', async () => {
    const composed = await compose()
    const undeclared = join(osHome, 'undeclared.patch.yml')
    const layers = composed.layers.map(layer => layer.packageName === '@deepseek-ai/dsh-base' ? { source: layer.source, patches: [] } : layer)
    const moved: ComposedStart = { ...composed, layers: [...layers, { source: undeclared, patches: [{ insert: [{ id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local' }] }] }], required: composed.required.map(row => row.id === 'sandbox' ? { id: 'sandbox', name: undefined } : row) }
    expect(await refused(() => { assertComposedInvariants(moved) })).toContain(`sandbox is inserted with the plugin "@deepseek-ai/dsh-sandbox-local" by a layer that does not declare it (set in ${undeclared})`)
  })

  it('refuses a booted Host that mounted a required row twice or with another plugin', async () => {
    const composed = await compose()
    const sandbox = composedRows(composed).find(row => row.id === 'sandbox')!
    const twice: BootedHost = { ...booted(composed), rows: () => [...booted(composed).rows(), { ...sandbox, name: '@x/no-sandbox' }] }
    const message = await refused(() => { assertDelorunInvariants(composed, twice) })
    expect(message).toContain('sandbox is mounted 2 times')
    expect(message).toContain('sandbox runs the plugin "@x/no-sandbox", not @deepseek-ai/dsh-sandbox-local')
  })
})

describe('the services of the required rows', { timeout: 60_000 }, () => {
  it('refuses a fetch guard or a sandbox service that another row or no row provides', async () => {
    const composed = await compose()
    const message = await refused(() => { assertDelorunInvariants(composed, booted(composed, [], { fetchGuard: { row: 'allow-all' }, sandbox: { row: undefined } })) })
    expect(message).toContain('fetchGuard is provided by the row allow-all, not by delorun-fetch-guard')
    expect(message).toContain('sandbox is provided by no plugin row, not by sandbox')
  })

  it('refuses an enabled consent row that provides no service, and accepts none from a consent row switched off', async () => {
    const composed = await compose()
    expect(await refused(() => { assertDelorunInvariants(composed, booted(composed, [], { writeConsent: undefined })) })).toContain('writeConsent is not provided by delorun-instruction-consent')
    const off = booted(composed, [{ id: 'delorun-schedule-consent', name: '@delorun/plugin-schedule-consent', disabled: false, state: 'active', config: { enabled: false } }])
    expect(await refused(() => { assertDelorunInvariants(composed, off) })).toContain('delorun-schedule-consent has enabled false')
    expect(await refused(() => { assertDelorunInvariants(composed, off) })).not.toContain('scheduleConsent')
  })
})

describe('a booted Host whose consent row mounted a fail-closed stand-in', { timeout: 60_000 }, () => {
  it.each([
    ['delorun-delegation-consent', 'delegationConsent'],
    ['delorun-schedule-consent', 'scheduleConsent'],
    ['delorun-permission-defaults', 'sandboxModeGuard'],
    ['delorun-permission-defaults', 'sandboxNetwork'],
  ])('refuses to report %s healthy when its %s is the stand-in', async (row, service) => {
    const composed = await compose()
    const message = await refused(() => { assertDelorunInvariants(composed, booted(composed, [], { [service]: { row, failClosed: true } })) })
    expect(message).toContain(`${service} is a fail-closed stand-in`)
  })
})

describe('a booted Host', { timeout: 60_000 }, () => {
  it('refuses a Delorun row that did not start or is disabled, and a missing turn gate', async () => {
    const composed = await compose()
    const message = await refused(() => {
      assertDelorunInvariants(composed, booted(composed, [
        { id: 'delorun-trash', name: '@delorun/plugin-trash', disabled: false, state: 'failed' },
        { id: 'delorun-privacy', name: '@delorun/bundle-local', disabled: true, state: 'active' },
      ], { [TURN_GATE_SERVICE]: undefined }))
    })
    expect(message).toContain('stopped it')
    expect(message).toContain('delorun-trash did not start (failed)')
    expect(message).toContain('delorun-privacy is disabled')
    expect(message).toContain(`${TURN_GATE_SERVICE} is not provided`)
  })

  it('refuses a booted Host whose fetch guard plugin failed to load, so web_fetch never runs unguarded', async () => {
    const composed = await compose()
    const failed = booted(composed, [{ id: 'delorun-fetch-guard', name: '@delorun/plugin-fetch-guard', disabled: false, state: 'failed', config: { enabled: true } }], { fetchGuard: undefined })
    const message = await refused(() => { assertDelorunInvariants(composed, failed) })
    expect(message).toContain('delorun-fetch-guard did not start (failed)')
    expect(message).toContain('fetchGuard is not provided by delorun-fetch-guard')
    // A row that reports active but registered no service is refused as well.
    const silent = booted(composed, [], { fetchGuard: undefined })
    expect(await refused(() => { assertDelorunInvariants(composed, silent) })).toContain('fetchGuard is not provided by delorun-fetch-guard')
  })

  it('refuses a sandbox row that protects another home, misses a denied socket or an escape directory, or sets the runner', async () => {
    const composed = await compose()
    const message = await refused(() => {
      assertDelorunInvariants(composed, booted(composed, [{ id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local', disabled: false, state: 'active', config: { protectedHome: '/elsewhere', deniedSockets: [], runnerCommand: ['/bin/true'] } }]))
    })
    expect(message).toContain(`sandbox protects "/elsewhere", not the home ${delorunHome}`)
    expect(message).toContain(`does not deny ${join(delorunHome, 'run', 'default', 'update.sock')}`)
    expect(message).toContain(`sandbox does not hide the escape directories ${composed.protection.escapeSocketDirectories.join(', ')}`)
    expect(message).toContain('sandbox shows confined commands the host\'s /tmp (privateTmp is not on)')
    expect(message).toContain('sandbox sets runnerCommand')
  })

  it('accepts a booted sandbox row that names every escape directory the start set, among its own', async () => {
    const composed = await compose()
    const [row] = composedRows(composed).filter(candidate => candidate.id === 'sandbox')
    const config = { ...isRecord(row?.config) ? row.config : {}, escapeSocketDirectories: ['/run/mine', ...composed.protection.escapeSocketDirectories] }
    expect(() => { assertDelorunInvariants(composed, booted(composed, [{ ...row!, config }])) }).not.toThrow()
  })

  it('refuses a Host without a sandbox row, and one whose row config is not an object', async () => {
    const composed = await compose()
    const rows = composedRows(composed).filter(row => row.id !== 'sandbox')
    expect(await refused(() => { assertDelorunInvariants(composed, { rows: () => rows, providerOf: () => undefined }) })).toContain('sandbox is not in the profile')
    expect(await refused(() => { assertDelorunInvariants(composed, booted(composed, [{ id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local', disabled: false, state: 'active', config: 'plain' }])) })).toContain('sandbox protects undefined')
    expect(await refused(() => { assertDelorunInvariants(composed, booted(composed, [{ id: 'delorun-mcp-consent', name: '@delorun/plugin-mcp-consent', disabled: false, state: 'active' }])) })).toContain('delorun-mcp-consent has enabled undefined')
  })
})

describe('safe mode', { timeout: 60_000 }, () => {
  it('exempts no required row: a person\'s row under a local name that claims a Delorun row\'s id is refused, and so is a Delorun row its overlay would disable', async () => {
    expect(await main(['recover', 'safe-mode'], context)).toBe(EXIT.ok)
    const path = appendToProfilePatch({ insert: [{ id: 'delorun-fetch-guard', name: './allow-all.js' }] })
    const local = pathToFileURL(join(delorunHome, 'profiles', 'default', 'allow-all.js')).href
    const message = await refused(compose)
    expect(message).toContain(`delorun-fetch-guard is inserted again, which would replace the plugin @delorun/plugin-fetch-guard, with "${local}" (set in ${path})`)
    expect(message).toContain('delorun-fetch-guard is disabled')
    writeFileSync(path, readFileSync(path, 'utf8').replace(/\n- insert:[\s\S]*$/u, '\n'))
    const composed = await compose()
    expect(composed.safe).toBeDefined()
    expect(await refused(() => { assertDelorunInvariants(composed, booted(composed, [{ id: 'delorun-trash', name: '@delorun/plugin-trash', disabled: true, state: 'active' }])) })).toContain('delorun-trash is disabled')
  })

  it('lets an opt-in Delorun row stay disabled, and still refuses a disabled row that is not opt-in', async () => {
    const composed = await compose()
    const optIn = [...OPT_IN_ROWS].filter(id => composed.required.some(row => row.id === id))
    expect(optIn).toEqual(['delorun-cost-meter', 'delorun-thinking-rsvp'])
    const rowOf = (id: string): BootedRow => ({ id, name: composed.required.find(row => row.id === id)?.name ?? '', disabled: true, state: 'active' })
    expect(() => { assertDelorunInvariants(composed, booted(composed, optIn.map(rowOf))) }).not.toThrow()
    expect(await refused(() => { assertDelorunInvariants(composed, booted(composed, [rowOf('delorun-trash')])) })).toContain('delorun-trash is disabled')
  })

  describe('with an optional pack added to the profile', () => {
    const PACKAGES = fileURLToPath(new URL('../../../packages/', import.meta.url))
    const PACKS = ['bundle-code-intelligence', 'bundle-webhooks', 'bundle-external-agents', 'bundle-browser', 'bundle-agent-hooks', 'bundle-computer-use-driver']
    /** Add a pack to the CLI profile the way a source checkout links a bundle. */
    function addPack(dir: string): void {
      const profileDir = join(delorunHome, 'profiles', 'default')
      const file = join(profileDir, 'package.json')
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
      manifest.dsh.profile.bundles.push(`@delorun/${dir}`)
      writeFileSync(file, JSON.stringify(manifest))
      const link = join(profileDir, 'node_modules', '@delorun', dir)
      mkdirSync(join(profileDir, 'node_modules', '@delorun'), { recursive: true })
      symlinkSync(join(PACKAGES, dir), link, 'junction')
    }

    it.each(PACKS)('%s: the profile composes and passes the start guard', async (dir) => {
      addPack(dir)
      const composed = await compose()
      expect(composed.required.length).toBeGreaterThan(0)
    })

    it('never lets a manifest excuse a security row: the sandbox, a guard and the unlock gate stay refused when disabled', async () => {
      const composed = await compose()
      const gate = composed.required.find(row => row.name === '@delorun/home-auth')!.id
      const ids = ['sandbox', 'delorun-fetch-guard', 'delorun-permission-defaults', gate]
      const dir = join(osHome, 'lying-manifest')
      mkdirSync(dir)
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ delorun: { requires: Object.fromEntries(ids.map(id => [id, { needs: [{ kind: 'env', name: 'X' }], fix: { kind: 'command', command: 'x' } }])) } }))
      const lying: ComposedStart = { ...composed, layers: composed.layers.map(layer => layer.packageDir === undefined ? layer : { ...layer, packageDir: dir }) }
      for (const id of ids) {
        const row = { id, name: composed.required.find(each => each.id === id)?.name ?? '', disabled: true, state: 'active' as const }
        expect(await refused(() => { assertDelorunInvariants(lying, booted(lying, [row])) }), id).toContain(`${id} is disabled`)
      }
    })

    it('still refuses a disabled row that its pack does not list under Needs setup', async () => {
      addPack('bundle-webhooks')
      const composed = await compose()
      const row: BootedRow = { id: 'webhook-runtime', name: '@deepseek-ai/dsh-webhook', disabled: true, state: 'active' }
      expect(await refused(() => { assertDelorunInvariants(composed, booted(composed, [row])) })).toContain('webhook-runtime is disabled')
    })
  })

  it('composes the safe-mode overlay before the sandbox overlay', async () => {
    expect(await main(['recover', 'safe-mode'], context)).toBe(EXIT.ok)
    const printed: string[] = []
    const composed = await composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output: { ...context, stdout: (text) => { printed.push(text) } }, env: {}, osHome }, { prepareProfile: upstreamDependencies().prepareProfile, approvedPluginContent: NO_APPROVED_CONTENT })
    expect(composed.safe).toBeDefined()
    expect(composed.patchFiles.at(-1)).toBe(join(delorunHome, 'run', 'default', 'sandbox.patch.yml'))
    expect(printed.join('')).toContain('Delorun starts in safe mode')
  })
})

describe('the approved plugin content slot', { timeout: 60_000 }, () => {
  it('is called with the draft and its overlays apply after safe mode\'s and before the sandbox overlay', async () => {
    const extra = join(osHome, 'approved.patch.yml')
    writePatch(extra, [{ id: 'delorun-trash', config: {} }])
    const drafts: unknown[] = []
    const composed = await composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome }, {
      prepareProfile: upstreamDependencies().prepareProfile,
      approvedPluginContent: (draft) => { drafts.push(draft.patchFiles); return Promise.resolve([extra]) },
    })
    expect(drafts).toEqual([[]])
    expect(composed.patchFiles).toEqual([extra, join(delorunHome, 'run', 'default', 'sandbox.patch.yml')])
    expect(await NO_APPROVED_CONTENT({ request: composed.request, resolvedProfile: composed.resolvedProfile, patchFiles: [], safe: undefined })).toEqual([])
  })

  it('passes a refusal of the step through, and an overlay of it that sets the sandbox runner is refused', async () => {
    const refusal = new CliError(EXIT.failed, 'delorun: the approved content of a plugin changed')
    await expect(composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome }, {
      prepareProfile: upstreamDependencies().prepareProfile,
      approvedPluginContent: () => Promise.reject(refusal),
    })).rejects.toBe(refusal)
    const extra = join(osHome, 'runner.patch.yml')
    writePatch(extra, [{ id: 'sandbox', config: { runnerCommand: ['/bin/true'] } }])
    expect(await refused(() => composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome }, {
      prepareProfile: upstreamDependencies().prepareProfile,
      approvedPluginContent: () => Promise.resolve([extra]),
    }))).toContain(`runnerCommand in ${extra}`)
  })
})

describe('the person\'s --patch overlays', { timeout: 60_000 }, () => {
  it('apply over the profile\'s layers and under the approved content and the sandbox overlay', async () => {
    const overlay = join(osHome, 'mine.patch.yml')
    writePatch(overlay, [{ id: 'delorun-trash', config: {} }])
    const extra = join(osHome, 'approved.patch.yml')
    writePatch(extra, [{ id: 'delorun-trash', config: {} }])
    const drafts: unknown[] = []
    const composed = await composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome, patchFiles: [overlay] }, {
      prepareProfile: upstreamDependencies().prepareProfile,
      approvedPluginContent: (draft) => { drafts.push(draft.patchFiles); return Promise.resolve([extra]) },
    })
    expect(drafts).toEqual([[overlay]])
    expect(composed.patchFiles).toEqual([overlay, extra, join(delorunHome, 'run', 'default', 'sandbox.patch.yml')])
  })

  it('are held to the invariants, naming the overlay that breaks one', async () => {
    const overlay = join(osHome, 'off.patch.yml')
    writePatch(overlay, [{ id: 'delorun-fetch-guard', disabled: true }])
    expect(await refused(() => composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome, patchFiles: [overlay] }, { prepareProfile: upstreamDependencies().prepareProfile, approvedPluginContent: NO_APPROVED_CONTENT }))).toContain(overlay)
  })

  it('are refused in safe mode, which says how to leave it', async () => {
    expect(await main(['recover', 'safe-mode'], context)).toBe(EXIT.ok)
    const overlay = join(osHome, 'mine.patch.yml')
    writePatch(overlay, [])
    const message = await refused(() => composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome, patchFiles: [overlay] }, { prepareProfile: upstreamDependencies().prepareProfile, approvedPluginContent: NO_APPROVED_CONTENT }))
    expect(message).toContain('safe mode')
    expect(message).toContain('delorun recover exit-safe-mode')
  })
})

describe('the headless profile', { timeout: 60_000 }, () => {
  beforeEach(async () => {
    await upstreamAddHeadlessBundle(delorunHome, context)
    mkdirSync(join(delorunHome, 'run', 'headless'), { recursive: true, mode: 0o700 })
  }, 60_000)

  it('requires the sandbox row and every row of the headless bundle with its plugin, and no prompts answer', async () => {
    const composed = await compose('headless', 'headless')
    expect(composed.required).toEqual([
      { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local' },
      { id: 'delorun-instruction-consent', name: '@delorun/plugin-instruction-consent' },
      { id: 'delorun-mcp-consent', name: '@delorun/plugin-mcp-consent' },
      { id: 'delorun-schedule-consent', name: '@delorun/plugin-schedule-consent' },
      { id: 'delorun-permission-defaults', name: '@delorun/plugin-permission-defaults' },
      { id: 'delorun-fetch-guard', name: '@delorun/plugin-fetch-guard' },
      { id: 'delorun-delegation-consent', name: '@delorun/plugin-delegation-consent' },
      { id: 'delorun-plugin-changes', name: '@delorun/plugin-changes' },
      { id: 'delorun-update-gate', name: '@delorun/bundle-local/update-gate' },
      { id: 'delorun-plugin-install-check', name: '@delorun/plugin-install-check' },
    ])
    expect(composed.prompts).toBeUndefined()
    expect(() => { assertDelorunInvariants(composed, booted(composed)) }).not.toThrow()
  })

  it('gives the permission row fullAccessEverywhere only when the CLI profile\'s answer is dangerous', async () => {
    expect((await compose('headless', 'headless')).values.get('delorun-permission-defaults')).toEqual({ enabled: true, fullAccessEverywhere: false })
    const directory = join(delorunHome, 'profiles', CLI_PROFILE)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'setup-answers.json'), JSON.stringify({ prompts: 'dangerous' }))
    expect((await compose('headless', 'headless')).values.get('delorun-permission-defaults')).toEqual({ enabled: true, fullAccessEverywhere: true })
  })

  it('holds the update gate to its start hold, which keeps the first step of a turn until the Host passed its check', async () => {
    const composed = await compose('headless', 'headless')
    const gate = composedRows(composed).find(row => row.id === 'delorun-update-gate')!
    expect(gate.config).toMatchObject({ enabled: true, holdUntilChecked: true })
    const released = booted(composed, [{ ...gate, config: { enabled: true, holdUntilChecked: false } }])
    expect(await refused(() => { assertDelorunInvariants(composed, released) })).toContain('delorun-update-gate has holdUntilChecked false, not true')
  })

  it('refuses a profile that cannot be loaded', async () => {
    expect(await refused(() => compose('cli', 'no-such-profile'))).toContain('the profile no-such-profile could not be loaded')
  })

  it('refuses a profile whose bundle list lacks the headless bundle before boot, naming the bundle and both remedies', async () => {
    const manifestPath = join(delorunHome, 'profiles', 'headless', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== HEADLESS_BUNDLE)
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const message = await refused(() => compose('headless', 'headless'))
    expect(message).toContain(`does not load Delorun's headless bundle ${HEADLESS_BUNDLE}`)
    expect(message).toContain(`remove ${join(delorunHome, 'profiles', 'headless', 'delorun-migrations.json')}`)
    expect(message).toContain(`remove the folder ${join(delorunHome, 'profiles', 'headless')}`)
  })

  it.each(HEADLESS_ROWS)('refuses a home patch that disables %s before boot, naming the file', async (id) => {
    writePatch(join(delorunHome, 'cordis.patch.yml'), [{ id, disabled: true }])
    expect(await refused(() => compose('headless', 'headless'))).toContain(`${id} is disabled (set in ${join(delorunHome, 'cordis.patch.yml')})`)
  })

  it.each(HEADLESS_ROWS)('refuses a profile patch that disables %s before boot, naming the file', async (id) => {
    const path = join(delorunHome, 'profiles', 'headless', 'cordis.patch.yml')
    writePatch(path, [{ id, disabled: true }])
    expect(await refused(() => compose('headless', 'headless'))).toContain(`${id} is disabled (set in ${path})`)
  })

  it.each(HEADLESS_ROWS)('refuses a patch that turns %s to enabled false, naming the file', async (id) => {
    const path = join(delorunHome, 'cordis.patch.yml')
    writePatch(path, [{ id, config: { enabled: false } }])
    const message = await refused(() => compose('headless', 'headless'))
    expect(message).toContain(`${id} has enabled false, not true, which a delorun headless run always has`)
    expect(message).toContain(`(set in ${path})`)
  })

  it.each(HEADLESS_SERVICES)('refuses a booted Host whose %s comes from another row', async (service, row) => {
    const composed = await compose('headless', 'headless')
    const message = await refused(() => { assertDelorunInvariants(composed, booted(composed, [], { [service]: { row: 'allow-all' } })) })
    expect(message).toContain(`${service} is provided by the row allow-all, not by ${row}`)
  })

  it.each(HEADLESS_SERVICES)('refuses a booted Host in which no row provides %s', async (service, row) => {
    const composed = await compose('headless', 'headless')
    const message = await refused(() => { assertDelorunInvariants(composed, booted(composed, [], { [service]: undefined })) })
    expect(message).toContain(`${service} is not provided`)
    expect(message).toContain(service === TURN_GATE_SERVICE ? 'an update or a stop could not refuse new turns' : `by ${row}`)
  })
})

/** The plugins `@delorun/bundle-local`'s patch of the plugin manager's row protects. */
const PROTECTED = (parse(readFileSync(join(import.meta.dirname, '../../../packages/bundle-local/cordis.patch.yml'), 'utf8')) as { id?: string, config?: { protectedPlugins?: string[] } }[])
  .find(patch => patch.id === 'plugin-manager')?.config?.protectedPlugins ?? []

describe('the plugin manager\'s row', { timeout: 60_000 }, () => {
  it('asks no mirror until the install check\'s npmMirror setting is on, and keeps the protected plugins either way', async () => {
    expect(PROTECTED).toContain('@delorun/plugin-install-check')
    expect((await compose()).npmMirror).toBe(false)
    appendToProfilePatch({ id: 'delorun-plugin-install-check', config: { enabled: true, npmMirror: true } })
    const mirrored = await compose()
    expect(mirrored.npmMirror).toBe(true)
    expect(composedRow(mirrored.layers, 'plugin-manager')?.config).toMatchObject({ protectedPlugins: PROTECTED })
    expect(() => { assertDelorunInvariants(mirrored, booted(mirrored)) }).not.toThrow()
  })

  it('accepts a plain http registry, which the install check warns about, and refuses a patch that drops a protected plugin', async () => {
    appendToProfilePatch({ id: 'plugin-manager', config: { registry: 'http://registry.example.test/', protectedPlugins: PROTECTED } })
    await compose()
    const path = appendToProfilePatch({ id: 'plugin-manager', config: { protectedPlugins: ['@delorun/plugin-fetch-guard'] } })
    const message = await refused(compose)
    expect(message).toContain(`plugin-manager no longer protects ${PROTECTED.filter(name => name !== '@delorun/plugin-fetch-guard').join(', ')}; a patch of the row replaces its whole config, so restate protectedPlugins with every name Delorun's bundle lists (set in `)
    expect(message).toContain(`, ${path})`)
  })

  it('refuses a booted Host whose plugin manager protects fewer plugins than Delorun\'s bundle lists', async () => {
    const composed = await compose()
    const manager = { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager', disabled: false, state: 'active' as const, config: { protectedPlugins: [] } }
    expect(await refused(() => { assertDelorunInvariants(composed, booted(composed, [manager])) })).toContain('plugin-manager no longer protects @delorun/plugin-instruction-consent')
  })
})

describe('a Delorun row from another copy of its package', { timeout: 60_000 }, () => {
  it('refuses a same-named stand-in of a Delorun bundle that the profile resolved, naming the row, the package and both places', async () => {
    // Resolution order puts the installation's copy first today; the invariant holds without relying on that order.
    const standIn = join(delorunHome, 'profiles', 'default', 'node_modules', '@delorun', 'bundle-local-stand-in')
    const prepared = await upstreamDependencies().prepareProfile('default')
    const real = realpathSync(prepared.profile.layers.find(layer => layer.packageName === '@delorun/bundle-local')!.packageDir)
    cpSync(real, standIn, { recursive: true, filter: source => !source.slice(real.length).includes(`${sep}node_modules`) })
    const layers = prepared.profile.layers.map(layer => layer.packageName === '@delorun/bundle-local' ? { ...layer, packageDir: standIn } : layer)
    const message = await refused(() => composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome }, {
      prepareProfile: () => Promise.resolve({ ...prepared, profile: { ...prepared.profile, layers } }),
      approvedPluginContent: NO_APPROVED_CONTENT,
    }))
    expect(message).toContain(`delorun-fetch-guard loads @delorun/bundle-local from ${standIn}, which is not this Delorun's own copy in `)
    expect(message).toContain(`delorun-update-gate loads @delorun/bundle-local from ${standIn}`)
  })

  it('records where each required Delorun row resolves, inside this Delorun\'s packages', async () => {
    const composed = await compose()
    const installCheck = composed.rowPackages.filter(row => row.id === 'delorun-plugin-install-check').map(row => row.packageName)
    expect(installCheck).toEqual(['@delorun/bundle-local', '@delorun/plugin-install-check'])
    expect(composed.rowPackages.every(row => row.dir.startsWith(composed.packagesRoot))).toBe(true)
  })
})
