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
import { NO_RELEASE_PACKS } from '../src/release-packs.ts'
import { main } from '../src/main.ts'
import { composedRow, isRecord } from '../src/patch-layers.ts'
import { promptRows } from '@delorun/setup-apply'
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
/** The installed packs' review copies and the patches appended to them, by bundle name. */
const packExtras = new Map<string, { readonly active: string, readonly patch: readonly object[] }>()

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
  await prepareHome(context, undefined, true)
}, 60_000)

afterEach(() => {
  packExtras.clear()
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
  return composeDelorunProfile({ home: delorunHome, profile, kind, output: context, env: {}, osHome }, { prepareProfile: upstreamDependencies().prepareProfile, approvedPluginContent: NO_APPROVED_CONTENT, releasePacks: NO_RELEASE_PACKS })
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
      { id: 'delorun-prompt-wording', name: '@delorun/bundle-local/prompt-wording' },
      { id: 'delorun-mcp-consent', name: '@delorun/plugin-mcp-consent' },
    ]))
    expect(composed.prompts).toBe('safer')
    expect(() => { assertDelorunInvariants(composed, booted(composed)) }).not.toThrow()
  })

  it('mounts Delorun\'s prompt wording on in the composed studio profile, so C16 switch model_prompt is on wherever Delorun runs', async () => {
    const composed = await compose()
    const row = composedRows(composed).find(each => each.id === 'delorun-prompt-wording')
    expect(row).toMatchObject({ name: '@delorun/bundle-local/prompt-wording', config: { enabled: true } })
    expect(row?.disabled).not.toBe(true)
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
    expect(await refused(() => composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome }, { prepareProfile: () => Promise.reject('no manifest'), approvedPluginContent: NO_APPROVED_CONTENT, releasePacks: NO_RELEASE_PACKS }))).toContain('could not be loaded: no manifest')
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
      releasePacks: NO_RELEASE_PACKS,
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
    const composed = await composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output: { ...context, stdout: (text) => { printed.push(text) } }, env: {}, osHome }, { prepareProfile: upstreamDependencies().prepareProfile, approvedPluginContent: NO_APPROVED_CONTENT, releasePacks: NO_RELEASE_PACKS })
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
      releasePacks: NO_RELEASE_PACKS,
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
      releasePacks: NO_RELEASE_PACKS,
    })).rejects.toBe(refusal)
    const extra = join(osHome, 'runner.patch.yml')
    writePatch(extra, [{ id: 'sandbox', config: { runnerCommand: ['/bin/true'] } }])
    expect(await refused(() => composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome }, {
      prepareProfile: upstreamDependencies().prepareProfile,
      approvedPluginContent: () => Promise.resolve([extra]),
      releasePacks: NO_RELEASE_PACKS,
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
      releasePacks: NO_RELEASE_PACKS,
    })
    expect(drafts).toEqual([[overlay]])
    expect(composed.patchFiles).toEqual([overlay, extra, join(delorunHome, 'run', 'default', 'sandbox.patch.yml')])
  })

  it('are held to the invariants, naming the overlay that breaks one', async () => {
    const overlay = join(osHome, 'off.patch.yml')
    writePatch(overlay, [{ id: 'delorun-fetch-guard', disabled: true }])
    expect(await refused(() => composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome, patchFiles: [overlay] }, { prepareProfile: upstreamDependencies().prepareProfile, approvedPluginContent: NO_APPROVED_CONTENT, releasePacks: NO_RELEASE_PACKS }))).toContain(overlay)
  })

  it('are refused in safe mode, which says how to leave it', async () => {
    expect(await main(['recover', 'safe-mode'], context)).toBe(EXIT.ok)
    const overlay = join(osHome, 'mine.patch.yml')
    writePatch(overlay, [])
    const message = await refused(() => composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome, patchFiles: [overlay] }, { prepareProfile: upstreamDependencies().prepareProfile, approvedPluginContent: NO_APPROVED_CONTENT, releasePacks: NO_RELEASE_PACKS }))
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
      { id: 'delorun-tool-failure-guard', name: '@delorun/plugin-tool-failure-guard' },
      { id: 'delorun-delegation-consent', name: '@delorun/plugin-delegation-consent' },
      { id: 'delorun-plugin-changes', name: '@delorun/plugin-changes' },
      { id: 'delorun-update-gate', name: '@delorun/bundle-local/update-gate' },
      { id: 'delorun-prompt-wording', name: '@delorun/bundle-local/prompt-wording' },
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

/** The optional pack bundles a release publishes, as their source packages are named. */
const RELEASE_PACK_DIRS = ['bundle-browser', 'bundle-code-intelligence', 'bundle-agent-hooks', 'bundle-webhooks', 'bundle-external-agents', 'bundle-computer-use-driver'] as const

/** The source packages the pack bundles are built from. */
const SOURCE_PACKAGES = fileURLToPath(new URL('../../../packages/', import.meta.url))

/**
 * Copy a package folder without its `node_modules`.
 * @param from - the folder.
 * @param to - the copy.
 */
function copyPackage(from: string, to: string): void {
  cpSync(from, to, { recursive: true, filter: source => !source.slice(from.length).includes(`${sep}node_modules`) })
}

/**
 * Install a pack the way a release installs it and Changes activates it: the unpacked pack under
 * `packs/<release>/@delorun__<name>/package`, its Changes review copy under `changes/profiles/default/active/@delorun+<name>`
 * with real copies of the packages it declares in its own `node_modules`, and the profile linking that copy and listing
 * the bundle. Nothing of it lies inside this Delorun's own packages.
 * @param dir - the pack's source package folder, such as `bundle-webhooks`.
 * @param patch - patches appended to the review copy's bundle patch.
 * @returns the review copy's folder.
 */
function installReleasePack(dir: string, patch: readonly object[] = [], approvedSource?: string): string {
  const name = `@delorun/${dir}`
  const source = realpathSync(join(SOURCE_PACKAGES, dir))
  const unpacked = join(delorunHome, 'packs', '0.1.0', `@delorun__${dir}`, 'package')
  copyPackage(source, unpacked)
  rmSync(join(delorunHome, 'packs', 'current'), { force: true })
  symlinkSync('0.1.0', join(delorunHome, 'packs', 'current'))
  const active = join(delorunHome, 'changes', 'profiles', 'default', 'active', `@delorun+${dir}`)
  copyPackage(unpacked, active)
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  for (const dependency of Object.keys(manifest.dependencies ?? {})) copyPackage(realpathSync(join(source, 'node_modules', dependency)), join(active, 'node_modules', dependency))
  if (patch.length > 0) writeFileSync(join(active, 'cordis.patch.yml'), `${readFileSync(join(active, 'cordis.patch.yml'), 'utf8')}\n${stringify(patch)}`)
  packExtras.set(name, { active, patch })
  const profileDir = join(delorunHome, 'profiles', 'default')
  const file = join(profileDir, 'package.json')
  const profile = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string>, dsh: { profile: { bundles: string[] } }, delorun?: { changes?: { schema: string, plugins: Record<string, object> } } }
  profile.dependencies = { ...profile.dependencies, [name]: `link:${active}` }
  const plugins = { ...profile.delorun?.changes?.plugins, [name]: { source: approvedSource ?? join(delorunHome, 'packs', 'current', `@delorun__${dir}`, 'package'), version: 'a'.repeat(64), approvedAt: '2026-11-17T09:30:00.000Z' } }
  profile.delorun = { ...profile.delorun, changes: { schema: 'delorun.changes-approved/1', plugins } }
  profile.dsh.profile.bundles.push(name)
  writeFileSync(file, JSON.stringify(profile))
  mkdirSync(join(profileDir, 'node_modules', '@delorun'), { recursive: true })
  symlinkSync(active, join(profileDir, 'node_modules', '@delorun', dir))
  return active
}

/**
 * The folder the release `0.1.0` installs a pack in.
 * @param name - the pack's package name.
 * @returns `packs/0.1.0/<name>/package` under the home.
 */
function packFolder(name: string): string {
  return join(delorunHome, 'packs', '0.1.0', name.replace('/', '__'), 'package')
}

/**
 * The running release's packs as `runningReleasePacks` reads them: each name with its folder.
 * @param names - the names the release's verified packs file lists.
 * @returns the packs.
 */
function releasePacksOf(names: readonly string[]): () => Promise<ReadonlyMap<string, string>> {
  return () => Promise.resolve(new Map(names.map(name => [name, packFolder(name)])))
}

/**
 * Compose the default profile with a list of the running release's packs. A release's runtime does not carry the packs, so
 * its resolution loads each pack bundle from the review copy the profile links; a source checkout resolves the workspace's
 * copy first, so each installed pack's layer is pointed at its review copy, with the patches appended to it.
 * @param packs - the names the release's verified packs file lists.
 * @returns the composed start.
 */
function composeWithPacks(packs: readonly string[]): Promise<ComposedStart> {
  const prepare = upstreamDependencies().prepareProfile
  return composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome }, {
    prepareProfile: async (profile) => {
      const prepared = await prepare(profile)
      const layers = prepared.profile.layers.map((layer) => {
        const extra = packExtras.get(layer.packageName)
        return extra === undefined ? layer : { ...layer, packageDir: extra.active, patchPaths: [join(extra.active, 'cordis.patch.yml')], patches: [...layer.patches, ...extra.patch] }
      })
      return { ...prepared, profile: { ...prepared.profile, layers } }
    },
    approvedPluginContent: NO_APPROVED_CONTENT,
    releasePacks: releasePacksOf(packs),
  })
}

describe('a profile with the release\'s optional packs installed through Changes', { timeout: 120_000 }, () => {
  const ALL = RELEASE_PACK_DIRS.map(dir => `@delorun/${dir}`)

  it('was refused as a same-named stand-in when nothing told the packs from Delorun\'s own bundles', async () => {
    const active = installReleasePack('bundle-webhooks')
    const message = await refused(() => composeWithPacks([]))
    expect(message).toContain(`webhook-runtime loads @delorun/bundle-webhooks from ${active}, which is not this Delorun's own copy in `)
    expect(message).toContain(`github-webhook-server loads @delorun/bundle-webhooks from ${active}`)
  })

  it('starts with every pack installed: no pack row is required, and every required row still loads from this Delorun\'s packages', async () => {
    const actives = RELEASE_PACK_DIRS.map(dir => installReleasePack(dir))
    const composed = await composeWithPacks(ALL)
    expect(composed.packBundles).toEqual(new Set(ALL))
    const packRows = composed.layers.filter(layer => layer.packageName !== undefined && composed.packBundles.has(layer.packageName)).flatMap(layer => layer.patches.flatMap(patch => Array.isArray(patch.insert) ? patch.insert : []))
    expect(packRows.length).toBeGreaterThan(5)
    const required = new Set(composed.required.map(row => row.id))
    for (const id of ['webhook-runtime', 'github-webhook-ingress', 'github-webhook-server', 'browser-use', 'lsp', 'computer-use-registry']) expect(required.has(id), id).toBe(false)
    expect(required.has('delorun-fetch-guard')).toBe(true)
    expect(composed.rowPackages.length).toBeGreaterThan(0)
    expect(composed.rowPackages.every(row => row.dir.startsWith(composed.packagesRoot))).toBe(true)
    expect(composed.rowPackages.some(row => actives.some(active => row.dir.startsWith(active)))).toBe(false)
    expect(() => { assertDelorunInvariants(composed, booted(composed)) }).not.toThrow()
    // The next start reads the same profile and packs again.
    expect((await composeWithPacks(ALL)).required).toEqual(composed.required)
  })

  it('refuses a layer that only carries a pack\'s name: a profile link to another folder, or a review copy approved from one', async () => {
    const other = join(osHome, 'any-folder', 'bundle-webhooks')
    copyPackage(realpathSync(join(SOURCE_PACKAGES, 'bundle-webhooks')), other)
    const active = installReleasePack('bundle-webhooks', [], other)
    const fromOther = await refused(() => composeWithPacks(ALL))
    expect(fromOther).toContain(`webhook-runtime loads @delorun/bundle-webhooks from ${active}, which is not this Delorun's own copy in `)
    packExtras.set('@delorun/bundle-webhooks', { active: other, patch: [] })
    expect(await refused(() => composeWithPacks(ALL))).toContain(`webhook-runtime loads @delorun/bundle-webhooks from ${realpathSync(other)}, which is not this Delorun's own copy in `)
  })

  it('accepts a pack layer that loads from the release\'s pack folder itself, and not one from another release\'s', async () => {
    installReleasePack('bundle-webhooks')
    packExtras.set('@delorun/bundle-webhooks', { active: join(delorunHome, 'packs', 'current', '@delorun__bundle-webhooks', 'package'), patch: [] })
    expect((await composeWithPacks(ALL)).packBundles).toEqual(new Set(['@delorun/bundle-webhooks']))
    const older = join(delorunHome, 'packs', '0.0.9', '@delorun__bundle-webhooks', 'package')
    copyPackage(packFolder('@delorun/bundle-webhooks'), older)
    packExtras.set('@delorun/bundle-webhooks', { active: older, patch: [] })
    expect(await refused(() => composeWithPacks(ALL))).toContain(`webhook-runtime loads @delorun/bundle-webhooks from ${older}`)
  })

  it('starts without a pack bundle the profile skipped, with a notice, and refuses it when no packs list names it', async () => {
    const prepare = upstreamDependencies().prepareProfile
    const skipping = async (profile: string): ReturnType<typeof prepare> => {
      const prepared = await prepare(profile)
      return { ...prepared, profile: { ...prepared.profile, skippedBundles: [...prepared.profile.skippedBundles, { packageName: '@delorun/bundle-webhooks', reason: 'its folder is missing' }] } }
    }
    const printed: string[] = []
    const output = { ...context, stderr: (text: string) => { printed.push(text) } }
    await composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output, env: {}, osHome }, { prepareProfile: skipping, approvedPluginContent: NO_APPROVED_CONTENT, releasePacks: releasePacksOf(ALL) })
    expect(printed.join('')).toContain('delorun: the plugin pack @delorun/bundle-webhooks did not load in the profile default (its folder is missing), so Delorun starts without it.')
    expect(await refused(() => composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome }, { prepareProfile: skipping, approvedPluginContent: NO_APPROVED_CONTENT, releasePacks: NO_RELEASE_PACKS }))).toContain('@delorun/bundle-webhooks: its folder is missing')
  })

  it('still refuses a same-named stand-in of a runtime bundle beside the packs, even when a packs list names it', async () => {
    installReleasePack('bundle-webhooks')
    const standIn = join(delorunHome, 'profiles', 'default', 'node_modules', '@delorun', 'bundle-local-stand-in')
    const prepared = await upstreamDependencies().prepareProfile('default')
    copyPackage(realpathSync(prepared.profile.layers.find(layer => layer.packageName === '@delorun/bundle-local')!.packageDir), standIn)
    const layers = prepared.profile.layers.map(layer => layer.packageName === '@delorun/bundle-local' ? { ...layer, packageDir: standIn } : layer)
    const message = await refused(() => composeDelorunProfile({ home: delorunHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome }, {
      prepareProfile: () => Promise.resolve({ ...prepared, profile: { ...prepared.profile, layers } }),
      approvedPluginContent: NO_APPROVED_CONTENT,
      releasePacks: releasePacksOf(['@delorun/bundle-webhooks', '@delorun/bundle-local', '@delorun/bundle-studio']),
    }))
    expect(message).toContain(`delorun-fetch-guard loads @delorun/bundle-local from ${standIn}, which is not this Delorun's own copy in `)
  })

  it('refuses a pack that inserts a protected runtime row again, naming the pack\'s copy', async () => {
    const active = installReleasePack('bundle-webhooks', [{ insert: [{ id: 'delorun-permission-defaults', name: '@delorun/bundle-webhooks/server' }, { id: 'sandbox', name: '@delorun/bundle-webhooks/server' }] }])
    const message = await refused(() => composeWithPacks(ALL))
    expect(message).toContain('delorun-permission-defaults is inserted again, which would replace the plugin @delorun/plugin-permission-defaults, with "@delorun/bundle-webhooks/server"')
    expect(message).toContain('sandbox is inserted again')
    expect(message).toContain(join(active, 'cordis.patch.yml'))
  })

  it('refuses a pack that turns off, loosens or unprotects a protected runtime row, and a booted pack row in its place', async () => {
    const active = installReleasePack('bundle-webhooks', [
      { id: 'delorun-fetch-guard', disabled: true },
      { id: 'plugin-manager', config: { protectedPlugins: [] } },
    ])
    const message = await refused(() => composeWithPacks(ALL))
    expect(message).toContain(`delorun-fetch-guard is disabled (set in the bundle @delorun/bundle-webhooks (${join(active, 'cordis.patch.yml')}))`)
    expect(message).toContain('plugin-manager no longer protects')
    packExtras.set('@delorun/bundle-webhooks', { active, patch: [{ id: 'sandbox', config: { runnerCommand: ['sh'] } }] })
    expect(await refused(() => composeWithPacks(ALL))).toContain(`the sandbox row sets the runner itself (runnerCommand in the bundle @delorun/bundle-webhooks (${join(active, 'cordis.patch.yml')}))`)
    packExtras.clear()
    const composed = await composeWithPacks(ALL)
    const gate: BootedRow = { id: 'delorun-update-gate', name: '@delorun/bundle-webhooks/server', disabled: false, state: 'active' }
    expect(await refused(() => { assertDelorunInvariants(composed, booted(composed, [gate])) })).toContain('delorun-update-gate runs the plugin "@delorun/bundle-webhooks/server", not @delorun/bundle-local/update-gate')
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
      approvedPluginContent: NO_APPROVED_CONTENT, releasePacks: NO_RELEASE_PACKS,
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
