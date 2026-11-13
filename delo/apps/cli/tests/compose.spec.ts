/**
 * The one composition of a Host over a Delo home (`delo/apps/cli/src/compose.ts`) and its invariants. The specs set
 * up a real home with `delorun setup --yes`, compose its CLI profile with upstream's own profile preparation, and hold
 * the composed and the booted rows to the invariants: a layer that disables a Delo row or the sandbox row, or turns a
 * prompt switch away from the recorded answer, refuses the start naming the file; a booted Host whose rows, sandbox
 * settings or services differ from the composition refuses; a required row that another layer inserts again, or that
 * runs another plugin, refuses; safe mode exempts no required row; the "Same as stock" answer is honoured; and the
 * approved plugin content slot applies before the sandbox overlay.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse, stringify } from 'yaml'
import { prepareHome, type CommandContext } from '../src/command.ts'
import { assertComposedInvariants, assertDeloInvariants, composeDeloProfile, composedRows, NO_APPROVED_CONTENT, ROW_SERVICES, TURN_GATE_SERVICE, type BootedHost, type ComposedStart, type ComposeKind, type ServiceProvider } from '../src/compose.ts'
import { OPT_IN_ROWS, type BootedRow } from '../src/delo-bundles.ts'
import { CliError, EXIT } from '../src/exit.ts'
import { main } from '../src/main.ts'
import { composedRow, isRecord } from '../src/patch-layers.ts'
import { upstreamAddHeadlessBundle, upstreamDependencies } from '../src/start.ts'
import { HEADLESS_BUNDLE } from '@delo/bundle-local/profile'

/** The rows of `@delo/bundle-headless`. */
const HEADLESS_ROWS = ['delo-instruction-consent', 'delo-mcp-consent', 'delo-schedule-consent', 'delo-permission-defaults', 'delo-fetch-guard', 'delo-update-gate'] as const

/** The services the headless bundle's rows provide and the row each comes from. */
const HEADLESS_SERVICES = [
  ['fetchGuard', 'delo-fetch-guard'],
  ['writeConsent', 'delo-instruction-consent'],
  ['mcpAddConsent', 'delo-mcp-consent'],
  ['scheduleConsent', 'delo-schedule-consent'],
  ['sandboxModeGuard', 'delo-permission-defaults'],
  ['sandboxNetwork', 'delo-permission-defaults'],
  [TURN_GATE_SERVICE, 'delo-update-gate'],
] as const

let osHome: string
let deloHome: string
let context: CommandContext

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-compose-')))
  deloHome = join(osHome, '.delo')
  vi.stubEnv('HOME', osHome)
  vi.stubEnv('USERPROFILE', osHome)
  vi.stubEnv('DSH_HOME', join(osHome, '.dsh'))
  vi.stubEnv('DELO_HOME', undefined)
  vi.stubEnv('DELO_PROFILE', undefined)
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
  return composeDeloProfile({ home: deloHome, profile, kind, output: context, env: {}, osHome }, { prepareProfile: upstreamDependencies().prepareProfile, approvedPluginContent: NO_APPROVED_CONTENT })
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
  const path = join(deloHome, 'profiles', 'default', 'cordis.patch.yml')
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
  it('composes with the sandbox overlay last, requires the sandbox row and every Delo row, and passes once booted as composed', async () => {
    const composed = await compose()
    expect(composed.patchFiles).toEqual([join(deloHome, 'run', 'default', 'sandbox.patch.yml')])
    expect(composed.required).toEqual(expect.arrayContaining([
      { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local' },
      { id: 'delo-privacy', name: '@delo/bundle-local' },
      { id: 'delo-fetch-guard', name: '@delo/plugin-fetch-guard' },
      { id: 'delo-update-gate', name: '@delo/bundle-local/update-gate' },
      { id: 'delo-mcp-consent', name: '@delo/plugin-mcp-consent' },
    ]))
    expect(composed.prompts).toBe('safer')
    expect(() => { assertDeloInvariants(composed, booted(composed)) }).not.toThrow()
  })

  it('refuses a home patch that disables the fetch guard, naming the file and the remedy', async () => {
    writePatch(join(deloHome, 'cordis.patch.yml'), [{ id: 'delo-fetch-guard', disabled: true }])
    const message = await refused(compose)
    expect(message).toContain(`delo-fetch-guard is disabled (set in ${join(deloHome, 'cordis.patch.yml')})`)
    expect(message).toContain('delorun recover safe-mode --profile default')
  })

  it('refuses a profile patch that disables the sandbox row or the update gate', async () => {
    const path = appendToProfilePatch({ id: 'sandbox', disabled: true })
    appendToProfilePatch({ id: 'delo-update-gate', disabled: true })
    const message = await refused(compose)
    expect(message).toContain(`sandbox is disabled (set in ${path})`)
    expect(message).toContain('delo-update-gate is disabled')
  })

  it('refuses a patch that turns a consent row to its parity value without the "Same as stock" answer, and accepts it with that answer', async () => {
    writePatch(join(deloHome, 'cordis.patch.yml'), [{ id: 'delo-mcp-consent', config: { enabled: false } }])
    expect(await refused(compose)).toContain(`delo-mcp-consent has enabled false, not true, which the recorded prompts answer "Safer prompts" sets (set in ${join(deloHome, 'cordis.patch.yml')})`)
    const answers = join(deloHome, 'profiles', 'default', 'setup-answers.json')
    writeFileSync(answers, JSON.stringify({ ...JSON.parse(readFileSync(answers, 'utf8')) as object, prompts: 'stock' }))
    rmSync(join(deloHome, 'cordis.patch.yml'))
    for (const id of ['delo-instruction-consent', 'delo-mcp-consent', 'delo-permission-defaults', 'delo-schedule-consent']) appendToProfilePatch({ id, config: { enabled: false } })
    const composed = await compose()
    expect(composed.prompts).toBe('stock')
    expect(() => { assertDeloInvariants(composed, booted(composed)) }).not.toThrow()
  })

  it('refuses a consent row left on when the recorded answer is "Same as stock"', async () => {
    const answers = join(deloHome, 'profiles', 'default', 'setup-answers.json')
    writeFileSync(answers, JSON.stringify({ ...JSON.parse(readFileSync(answers, 'utf8')) as object, prompts: 'stock' }))
    expect(await refused(compose)).toContain('which the recorded prompts answer "Same as stock" sets')
  })

  it('reports a required row no layer inserts, and a profile preparation that throws a plain value', async () => {
    const composed = await compose()
    const ghost: ComposedStart = { ...composed, required: [...composed.required, { id: 'ghost', name: undefined }] }
    expect(composedRows(ghost).map(row => row.id)).not.toContain('ghost')
    expect(await refused(() => { assertComposedInvariants(ghost) })).toContain('ghost is not in the profile')
    expect(await refused(() => composeDeloProfile({ home: deloHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome }, { prepareProfile: () => Promise.reject('no manifest'), approvedPluginContent: NO_APPROVED_CONTENT }))).toContain('could not be loaded: no manifest')
  })

  it('refuses a fetch guard turned off whatever the answer', async () => {
    appendToProfilePatch({ id: 'delo-fetch-guard', config: { enabled: false } })
    expect(await refused(compose)).toContain('delo-fetch-guard has enabled false, not true, which stays on whatever the prompts answer')
  })
})

describe('a required row another layer replaces', { timeout: 60_000 }, () => {
  it('refuses a profile patch that inserts a second fetch guard row with another plugin, naming the file', async () => {
    const path = appendToProfilePatch({ insert: [{ id: 'delo-fetch-guard', name: './allow-all.js', config: { enabled: true } }] })
    const local = pathToFileURL(join(deloHome, 'profiles', 'default', 'allow-all.js')).href
    const message = await refused(compose)
    expect(message).toContain(`delo-fetch-guard is inserted again, which would replace the plugin @delo/plugin-fetch-guard, with "${local}" (set in ${path})`)
    expect(message).toContain(`delo-fetch-guard runs the plugin "${local}", not @delo/plugin-fetch-guard`)
  })

  it('refuses a home patch that inserts a second sandbox row, and an overlay that does', async () => {
    writePatch(join(deloHome, 'cordis.patch.yml'), [{ insert: [{ id: 'sandbox', name: '@x/no-sandbox' }] }])
    expect(await refused(compose)).toContain(`sandbox is inserted again, which would replace the plugin @deepseek-ai/dsh-sandbox-local, with "@x/no-sandbox" (set in ${join(deloHome, 'cordis.patch.yml')})`)
    rmSync(join(deloHome, 'cordis.patch.yml'))
    const extra = join(osHome, 'shadow.patch.yml')
    writePatch(extra, [{ insert: [{ id: 'sandbox', name: '@x/no-sandbox' }] }])
    expect(await refused(() => composeDeloProfile({ home: deloHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome }, {
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
    const message = await refused(() => { assertDeloInvariants(composed, twice) })
    expect(message).toContain('sandbox is mounted 2 times')
    expect(message).toContain('sandbox runs the plugin "@x/no-sandbox", not @deepseek-ai/dsh-sandbox-local')
  })
})

describe('the services of the required rows', { timeout: 60_000 }, () => {
  it('refuses a fetch guard or a sandbox service that another row or no row provides', async () => {
    const composed = await compose()
    const message = await refused(() => { assertDeloInvariants(composed, booted(composed, [], { fetchGuard: { row: 'allow-all' }, sandbox: { row: undefined } })) })
    expect(message).toContain('fetchGuard is provided by the row allow-all, not by delo-fetch-guard')
    expect(message).toContain('sandbox is provided by no plugin row, not by sandbox')
  })

  it('refuses an enabled consent row that provides no service, and accepts none from a consent row switched off', async () => {
    const composed = await compose()
    expect(await refused(() => { assertDeloInvariants(composed, booted(composed, [], { writeConsent: undefined })) })).toContain('writeConsent is not provided by delo-instruction-consent')
    const off = booted(composed, [{ id: 'delo-schedule-consent', name: '@delo/plugin-schedule-consent', disabled: false, state: 'active', config: { enabled: false } }])
    expect(await refused(() => { assertDeloInvariants(composed, off) })).toContain('delo-schedule-consent has enabled false')
    expect(await refused(() => { assertDeloInvariants(composed, off) })).not.toContain('scheduleConsent')
  })
})

describe('a booted Host', { timeout: 60_000 }, () => {
  it('refuses a Delo row that did not start or is disabled, and a missing turn gate', async () => {
    const composed = await compose()
    const message = await refused(() => {
      assertDeloInvariants(composed, booted(composed, [
        { id: 'delo-trash', name: '@delo/plugin-trash', disabled: false, state: 'failed' },
        { id: 'delo-privacy', name: '@delo/bundle-local', disabled: true, state: 'active' },
      ], { [TURN_GATE_SERVICE]: undefined }))
    })
    expect(message).toContain('stopped it')
    expect(message).toContain('delo-trash did not start (failed)')
    expect(message).toContain('delo-privacy is disabled')
    expect(message).toContain(`${TURN_GATE_SERVICE} is not provided`)
  })

  it('refuses a booted Host whose fetch guard plugin failed to load, so web_fetch never runs unguarded', async () => {
    const composed = await compose()
    const failed = booted(composed, [{ id: 'delo-fetch-guard', name: '@delo/plugin-fetch-guard', disabled: false, state: 'failed', config: { enabled: true } }], { fetchGuard: undefined })
    const message = await refused(() => { assertDeloInvariants(composed, failed) })
    expect(message).toContain('delo-fetch-guard did not start (failed)')
    expect(message).toContain('fetchGuard is not provided by delo-fetch-guard')
    // A row that reports active but registered no service is refused as well.
    const silent = booted(composed, [], { fetchGuard: undefined })
    expect(await refused(() => { assertDeloInvariants(composed, silent) })).toContain('fetchGuard is not provided by delo-fetch-guard')
  })

  it('refuses a sandbox row that protects another home, misses a denied socket or an escape directory, or sets the runner', async () => {
    const composed = await compose()
    const message = await refused(() => {
      assertDeloInvariants(composed, booted(composed, [{ id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local', disabled: false, state: 'active', config: { protectedHome: '/elsewhere', deniedSockets: [], runnerCommand: ['/bin/true'] } }]))
    })
    expect(message).toContain(`sandbox protects "/elsewhere", not the home ${deloHome}`)
    expect(message).toContain(`does not deny ${join(deloHome, 'run', 'default', 'update.sock')}`)
    expect(message).toContain(`sandbox does not hide the escape directories ${composed.protection.escapeSocketDirectories.join(', ')}`)
    expect(message).toContain('sandbox shows confined commands the host\'s /tmp (privateTmp is not on)')
    expect(message).toContain('sandbox sets runnerCommand')
  })

  it('accepts a booted sandbox row that names every escape directory the start set, among its own', async () => {
    const composed = await compose()
    const [row] = composedRows(composed).filter(candidate => candidate.id === 'sandbox')
    const config = { ...isRecord(row?.config) ? row.config : {}, escapeSocketDirectories: ['/run/mine', ...composed.protection.escapeSocketDirectories] }
    expect(() => { assertDeloInvariants(composed, booted(composed, [{ ...row!, config }])) }).not.toThrow()
  })

  it('refuses a Host without a sandbox row, and one whose row config is not an object', async () => {
    const composed = await compose()
    const rows = composedRows(composed).filter(row => row.id !== 'sandbox')
    expect(await refused(() => { assertDeloInvariants(composed, { rows: () => rows, providerOf: () => undefined }) })).toContain('sandbox is not in the profile')
    expect(await refused(() => { assertDeloInvariants(composed, booted(composed, [{ id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local', disabled: false, state: 'active', config: 'plain' }])) })).toContain('sandbox protects undefined')
    expect(await refused(() => { assertDeloInvariants(composed, booted(composed, [{ id: 'delo-mcp-consent', name: '@delo/plugin-mcp-consent', disabled: false, state: 'active' }])) })).toContain('delo-mcp-consent has enabled undefined')
  })
})

describe('safe mode', { timeout: 60_000 }, () => {
  it('exempts no required row: a person\'s row under a local name that claims a Delo row\'s id is refused, and so is a Delo row its overlay would disable', async () => {
    expect(await main(['recover', 'safe-mode'], context)).toBe(EXIT.ok)
    const path = appendToProfilePatch({ insert: [{ id: 'delo-fetch-guard', name: './allow-all.js' }] })
    const local = pathToFileURL(join(deloHome, 'profiles', 'default', 'allow-all.js')).href
    const message = await refused(compose)
    expect(message).toContain(`delo-fetch-guard is inserted again, which would replace the plugin @delo/plugin-fetch-guard, with "${local}" (set in ${path})`)
    expect(message).toContain('delo-fetch-guard is disabled')
    writeFileSync(path, readFileSync(path, 'utf8').replace(/\n- insert:[\s\S]*$/u, '\n'))
    const composed = await compose()
    expect(composed.safe).toBeDefined()
    expect(await refused(() => { assertDeloInvariants(composed, booted(composed, [{ id: 'delo-trash', name: '@delo/plugin-trash', disabled: true, state: 'active' }])) })).toContain('delo-trash is disabled')
  })

  it('lets an opt-in Delo row stay disabled, and still refuses a disabled row that is not opt-in', async () => {
    const composed = await compose()
    const optIn = [...OPT_IN_ROWS]
    expect(optIn.length).toBeGreaterThan(0)
    for (const id of optIn) expect(composed.required.map(row => row.id)).toContain(id)
    const rowOf = (id: string): BootedRow => ({ id, name: composed.required.find(row => row.id === id)?.name ?? '', disabled: true, state: 'active' })
    expect(() => { assertDeloInvariants(composed, booted(composed, optIn.map(rowOf))) }).not.toThrow()
    expect(await refused(() => { assertDeloInvariants(composed, booted(composed, [rowOf('delo-trash')])) })).toContain('delo-trash is disabled')
  })

  it('composes the safe-mode overlay before the sandbox overlay', async () => {
    expect(await main(['recover', 'safe-mode'], context)).toBe(EXIT.ok)
    const printed: string[] = []
    const composed = await composeDeloProfile({ home: deloHome, profile: 'default', kind: 'cli', output: { ...context, stdout: (text) => { printed.push(text) } }, env: {}, osHome }, { prepareProfile: upstreamDependencies().prepareProfile, approvedPluginContent: NO_APPROVED_CONTENT })
    expect(composed.safe).toBeDefined()
    expect(composed.patchFiles.at(-1)).toBe(join(deloHome, 'run', 'default', 'sandbox.patch.yml'))
    expect(printed.join('')).toContain('Delo starts in safe mode')
  })
})

describe('the approved plugin content slot', { timeout: 60_000 }, () => {
  it('is called with the draft and its overlays apply after safe mode\'s and before the sandbox overlay', async () => {
    const extra = join(osHome, 'approved.patch.yml')
    writePatch(extra, [{ id: 'delo-trash', config: {} }])
    const drafts: unknown[] = []
    const composed = await composeDeloProfile({ home: deloHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome }, {
      prepareProfile: upstreamDependencies().prepareProfile,
      approvedPluginContent: (draft) => { drafts.push(draft.patchFiles); return Promise.resolve([extra]) },
    })
    expect(drafts).toEqual([[]])
    expect(composed.patchFiles).toEqual([extra, join(deloHome, 'run', 'default', 'sandbox.patch.yml')])
    expect(await NO_APPROVED_CONTENT({ request: composed.request, resolvedProfile: composed.resolvedProfile, patchFiles: [], safe: undefined })).toEqual([])
  })

  it('passes a refusal of the step through, and an overlay of it that sets the sandbox runner is refused', async () => {
    const refusal = new CliError(EXIT.failed, 'delorun: the approved content of a plugin changed')
    await expect(composeDeloProfile({ home: deloHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome }, {
      prepareProfile: upstreamDependencies().prepareProfile,
      approvedPluginContent: () => Promise.reject(refusal),
    })).rejects.toBe(refusal)
    const extra = join(osHome, 'runner.patch.yml')
    writePatch(extra, [{ id: 'sandbox', config: { runnerCommand: ['/bin/true'] } }])
    expect(await refused(() => composeDeloProfile({ home: deloHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome }, {
      prepareProfile: upstreamDependencies().prepareProfile,
      approvedPluginContent: () => Promise.resolve([extra]),
    }))).toContain(`runnerCommand in ${extra}`)
  })
})

describe('the headless profile', { timeout: 60_000 }, () => {
  beforeEach(async () => {
    await upstreamAddHeadlessBundle(deloHome, context)
    mkdirSync(join(deloHome, 'run', 'headless'), { recursive: true, mode: 0o700 })
  }, 60_000)

  it('requires the sandbox row and every row of the headless bundle with its plugin, and no prompts answer', async () => {
    const composed = await compose('headless', 'headless')
    expect(composed.required).toEqual([
      { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local' },
      { id: 'delo-instruction-consent', name: '@delo/plugin-instruction-consent' },
      { id: 'delo-mcp-consent', name: '@delo/plugin-mcp-consent' },
      { id: 'delo-schedule-consent', name: '@delo/plugin-schedule-consent' },
      { id: 'delo-permission-defaults', name: '@delo/plugin-permission-defaults' },
      { id: 'delo-fetch-guard', name: '@delo/plugin-fetch-guard' },
      { id: 'delo-update-gate', name: '@delo/bundle-local/update-gate' },
      { id: 'delo-plugin-install-check', name: '@delo/plugin-install-check' },
    ])
    expect(composed.prompts).toBeUndefined()
    expect(() => { assertDeloInvariants(composed, booted(composed)) }).not.toThrow()
  })

  it('holds the update gate to its start hold, which keeps the first step of a turn until the Host passed its check', async () => {
    const composed = await compose('headless', 'headless')
    const gate = composedRows(composed).find(row => row.id === 'delo-update-gate')!
    expect(gate.config).toMatchObject({ enabled: true, holdUntilChecked: true })
    const released = booted(composed, [{ ...gate, config: { enabled: true, holdUntilChecked: false } }])
    expect(await refused(() => { assertDeloInvariants(composed, released) })).toContain('delo-update-gate has holdUntilChecked false, not true')
  })

  it('refuses a profile that cannot be loaded', async () => {
    expect(await refused(() => compose('cli', 'no-such-profile'))).toContain('the profile no-such-profile could not be loaded')
  })

  it('refuses a profile whose bundle list lacks the headless bundle before boot, naming the bundle and both remedies', async () => {
    const manifestPath = join(deloHome, 'profiles', 'headless', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== HEADLESS_BUNDLE)
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const message = await refused(() => compose('headless', 'headless'))
    expect(message).toContain(`does not load Delo's headless bundle ${HEADLESS_BUNDLE}`)
    expect(message).toContain(`remove ${join(deloHome, 'profiles', 'headless', 'delo-migrations.json')}`)
    expect(message).toContain(`remove the folder ${join(deloHome, 'profiles', 'headless')}`)
  })

  it.each(HEADLESS_ROWS)('refuses a home patch that disables %s before boot, naming the file', async (id) => {
    writePatch(join(deloHome, 'cordis.patch.yml'), [{ id, disabled: true }])
    expect(await refused(() => compose('headless', 'headless'))).toContain(`${id} is disabled (set in ${join(deloHome, 'cordis.patch.yml')})`)
  })

  it.each(HEADLESS_ROWS)('refuses a profile patch that disables %s before boot, naming the file', async (id) => {
    const path = join(deloHome, 'profiles', 'headless', 'cordis.patch.yml')
    writePatch(path, [{ id, disabled: true }])
    expect(await refused(() => compose('headless', 'headless'))).toContain(`${id} is disabled (set in ${path})`)
  })

  it.each(HEADLESS_ROWS)('refuses a patch that turns %s to enabled false, naming the file', async (id) => {
    const path = join(deloHome, 'cordis.patch.yml')
    writePatch(path, [{ id, config: { enabled: false } }])
    const message = await refused(() => compose('headless', 'headless'))
    expect(message).toContain(`${id} has enabled false, not true, which a delorun headless run always has`)
    expect(message).toContain(`(set in ${path})`)
  })

  it.each(HEADLESS_SERVICES)('refuses a booted Host whose %s comes from another row', async (service, row) => {
    const composed = await compose('headless', 'headless')
    const message = await refused(() => { assertDeloInvariants(composed, booted(composed, [], { [service]: { row: 'allow-all' } })) })
    expect(message).toContain(`${service} is provided by the row allow-all, not by ${row}`)
  })

  it.each(HEADLESS_SERVICES)('refuses a booted Host in which no row provides %s', async (service, row) => {
    const composed = await compose('headless', 'headless')
    const message = await refused(() => { assertDeloInvariants(composed, booted(composed, [], { [service]: undefined })) })
    expect(message).toContain(`${service} is not provided`)
    expect(message).toContain(service === TURN_GATE_SERVICE ? 'an update or a stop could not refuse new turns' : `by ${row}`)
  })
})

/** The plugins `@delo/bundle-local`'s patch of the plugin manager's row protects. */
const PROTECTED = (parse(readFileSync(join(import.meta.dirname, '../../../packages/bundle-local/cordis.patch.yml'), 'utf8')) as { id?: string, config?: { protectedPlugins?: string[] } }[])
  .find(patch => patch.id === 'plugin-manager')?.config?.protectedPlugins ?? []

describe('the plugin manager\'s row', { timeout: 60_000 }, () => {
  it('asks no mirror until the install check\'s npmMirror setting is on, and keeps the protected plugins either way', async () => {
    expect(PROTECTED).toContain('@delo/plugin-install-check')
    expect((await compose()).npmMirror).toBe(false)
    appendToProfilePatch({ id: 'delo-plugin-install-check', config: { enabled: true, npmMirror: true } })
    const mirrored = await compose()
    expect(mirrored.npmMirror).toBe(true)
    expect(composedRow(mirrored.layers, 'plugin-manager')?.config).toMatchObject({ protectedPlugins: PROTECTED })
    expect(() => { assertDeloInvariants(mirrored, booted(mirrored)) }).not.toThrow()
  })

  it('accepts a plain http registry, which the install check warns about, and refuses a patch that drops a protected plugin', async () => {
    appendToProfilePatch({ id: 'plugin-manager', config: { registry: 'http://registry.example.test/', protectedPlugins: PROTECTED } })
    await compose()
    const path = appendToProfilePatch({ id: 'plugin-manager', config: { protectedPlugins: ['@delo/plugin-fetch-guard'] } })
    const message = await refused(compose)
    expect(message).toContain(`plugin-manager no longer protects ${PROTECTED.filter(name => name !== '@delo/plugin-fetch-guard').join(', ')}; a patch of the row replaces its whole config, so restate protectedPlugins with every name Delo's bundle lists (set in `)
    expect(message).toContain(`, ${path})`)
  })

  it('refuses a booted Host whose plugin manager protects fewer plugins than Delo\'s bundle lists', async () => {
    const composed = await compose()
    const manager = { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager', disabled: false, state: 'active' as const, config: { protectedPlugins: [] } }
    expect(await refused(() => { assertDeloInvariants(composed, booted(composed, [manager])) })).toContain('plugin-manager no longer protects @delo/plugin-instruction-consent')
  })
})

describe('a Delo row from another copy of its package', { timeout: 60_000 }, () => {
  it('refuses a same-named stand-in of a Delo bundle that the profile resolved, naming the row, the package and both places', async () => {
    // Resolution order puts the installation's copy first today; the invariant holds without relying on that order.
    const standIn = join(deloHome, 'profiles', 'default', 'node_modules', '@delo', 'bundle-local-stand-in')
    const prepared = await upstreamDependencies().prepareProfile('default')
    const real = realpathSync(prepared.profile.layers.find(layer => layer.packageName === '@delo/bundle-local')!.packageDir)
    cpSync(real, standIn, { recursive: true, filter: source => !source.slice(real.length).includes(`${sep}node_modules`) })
    const layers = prepared.profile.layers.map(layer => layer.packageName === '@delo/bundle-local' ? { ...layer, packageDir: standIn } : layer)
    const message = await refused(() => composeDeloProfile({ home: deloHome, profile: 'default', kind: 'cli', output: context, env: {}, osHome }, {
      prepareProfile: () => Promise.resolve({ ...prepared, profile: { ...prepared.profile, layers } }),
      approvedPluginContent: NO_APPROVED_CONTENT,
    }))
    expect(message).toContain(`delo-fetch-guard loads @delo/bundle-local from ${standIn}, which is not this Delo's own copy in `)
    expect(message).toContain(`delo-update-gate loads @delo/bundle-local from ${standIn}`)
  })

  it('records where each required Delo row resolves, inside this Delo\'s packages', async () => {
    const composed = await compose()
    const installCheck = composed.rowPackages.filter(row => row.id === 'delo-plugin-install-check').map(row => row.packageName)
    expect(installCheck).toEqual(['@delo/bundle-local', '@delo/plugin-install-check'])
    expect(composed.rowPackages.every(row => row.dir.startsWith(composed.packagesRoot))).toBe(true)
  })
})
