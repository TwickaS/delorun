/**
 * The C16 registry held against the tree: the switch fields, the parity
 * overlay, the model-visible contributions and the switch sweep, on the real
 * repository and on planted fixture trees.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { PARITY_OVERLAY_PATH, PARITY_SWITCHES, type BuiltParitySwitch, type ParitySwitchEntry } from '@delo/contract-parity-composition'
import { report, scanParity } from '../../src/parity/composition/check-parity-switches.ts'
import { changedLines, contributionErrors, findContributions } from '../../src/parity/composition/contributions.ts'
import { DEFAULT_PARITY, LOCAL_BUNDLE_PATCH_PATH, localBundleErrors, overlayErrors, parseOverlay, readOverlay } from '../../src/parity/composition/overlay.ts'
import { registryErrors, scenarioName, switchMarkers } from '../../src/parity/composition/switches.ts'
import { STAGED_ROOT, sweep, sweepLine } from '../../src/parity/composition/sweep.ts'

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A fixture repository with an empty ledger, the real overlay, the local bundle's patch and the given files.
 * @param files - repository paths and their contents.
 * @returns the fixture's root.
 */
function fixtureTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'delo-parity-'))
  roots.push(root)
  const all: Record<string, string> = {
    'delo/upstream-patches.json': JSON.stringify({ upstream: { repository: 'r', ref: 't', commit: '0'.repeat(40) }, forkOwned: ['delo/'], patches: [], retired: [] }),
    [PARITY_OVERLAY_PATH]: readFileSync(join(ROOT, PARITY_OVERLAY_PATH), 'utf8'),
    [LOCAL_BUNDLE_PATCH_PATH]: readFileSync(join(ROOT, LOCAL_BUNDLE_PATCH_PATH), 'utf8'),
    ...files,
  }
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const FIXTURE_PLUGIN = `import type { Context } from '@deepseek-ai/cordis'

/** A Delo plugin that adds runtime context to every model request. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.context({ name: 'delo:fixture', order: 0, text: () => 'planted' })
}
`

/** A registry with one built, model-visible switch over the given sources and no planned entry. */
function registryOver(sources: string[]): ParitySwitchEntry[] {
  return [{
    id: 'fixture_context', state: 'built', registeredBy: 'fixture', defaultValue: true, parityValue: false, modelVisible: true,
    scenario: 'session/delo-fixture-context', field: { module: '@delo/plugin-fixture', source: 'delo/packages/plugin-fixture/src/config.ts', key: 'fixtureContext' }, sources,
  }]
}

const FIXTURE_CONFIG = `/** The fixture's switch. */
export interface Config {
  /** Add the context. This is Delo's C16 switch \`fixture_context\`, off in the parity composition. */
  fixtureContext?: boolean
}

export const Config = z.object({
  fixtureContext: z.boolean().default(false),
})
`

describe('the real tree', () => {
  it('holds the registry, the overlay and every contribution, and reports each switch-on scenario', () => {
    const scan = scanParity(ROOT)
    expect(scan.errors).toEqual([])
    const lines = report(scan)
    expect(lines.at(-1)).toBe('parity-switches: ok')
    const built = PARITY_SWITCHES.filter((entry): entry is Extract<typeof entry, { state: 'built' }> => entry.state === 'built')
    expect(scan.markers.map(marker => marker.id).sort()).toEqual(built.map(entry => entry.id).sort())
    for (const entry of built) expect(scan.markers.find(marker => marker.id === entry.id)).toMatchObject({ path: entry.field.source, key: entry.field.key, defaultValue: entry.parityValue })
    // Every model-visible contribution must sit in a built switch's sources. A
    // switch may also name a file whose runtime behaviour it gates when the
    // visible effect is a tool result text rather than a registration (the
    // fetch guard's refusal flows through the provider's error), so the
    // sources union is a superset, never a subset.
    const contributionFiles = new Set(scan.contributions.map(contribution => contribution.path))
    const sourceFiles = new Set<string>(built.flatMap(entry => [...entry.sources]))
    for (const file of contributionFiles) expect(sourceFiles.has(file), file).toBe(true)
    // The scan walks every tracked file, so it takes several seconds under a loaded host.
  }, 60_000)

  it('names each model-visible switch\'s scenario after its id, and gives the feature switch none', () => {
    for (const entry of PARITY_SWITCHES as readonly ParitySwitchEntry[]) {
      if (entry.modelVisible) expect(entry.scenario?.split('/')[1]).toBe(scenarioName(entry.id))
      else expect(entry.scenario).toBeUndefined()
    }
    expect(PARITY_SWITCHES.find(entry => entry.id === 'doctor')).toMatchObject({ state: 'built', modelVisible: false })
  })
})

describe('the switch fields', () => {
  it('reads the switch id, the key and the schema default of each marked Config field', () => {
    expect(switchMarkers('delo/packages/plugin-fixture/src/config.ts', FIXTURE_CONFIG)).toEqual([
      { path: 'delo/packages/plugin-fixture/src/config.ts', line: 4, id: 'fixture_context', key: 'fixtureContext', defaultValue: false },
    ])
  })

  it('fails a Config field marked as a switch that the registry lacks', () => {
    const markers = switchMarkers('delo/packages/plugin-fixture/src/config.ts', FIXTURE_CONFIG)
    expect(registryErrors([], markers, () => true)).toEqual([
      'delo/packages/plugin-fixture/src/config.ts:4: Config field fixtureContext names C16 switch fixture_context, which is not in PARITY_SWITCHES',
    ])
  })

  it('fails a built entry whose field the tree lacks, and one whose default is not its parity value', () => {
    expect(registryErrors(registryOver(['delo/packages/plugin-fixture/src/config.ts']), [], () => true)).toEqual([
      'fixture_context: delo/packages/plugin-fixture/src/config.ts has no Config field fixtureContext whose JSDoc names C16 switch `fixture_context`',
    ])
    const onByDefault = switchMarkers('delo/packages/plugin-fixture/src/config.ts', FIXTURE_CONFIG.replace('.default(false)', '.default(true)'))
    expect(registryErrors(registryOver(['delo/packages/plugin-fixture/src/config.ts']), onByDefault, () => true)).toEqual([
      'fixture_context: the Config default of fixtureContext is true, not the parity value false',
    ])
  })

  it('fails a planned entry once its switch field exists, so the entry becomes built with that field', () => {
    const planned: ParitySwitchEntry = { id: 'fixture_context', state: 'planned', plannedBy: 'WP0', registeredBy: 'fixture', defaultValue: true, parityValue: false, modelVisible: true, scenario: 'session/delo-fixture-context' }
    const markers = switchMarkers('delo/packages/plugin-fixture/src/config.ts', FIXTURE_CONFIG)
    expect(registryErrors([planned], markers, () => true)).toEqual([
      'delo/packages/plugin-fixture/src/config.ts:4: Config field fixtureContext names C16 switch fixture_context, whose registry entry is still planned; make it built with this field',
    ])
  })
})

describe('the model-visible contributions', () => {
  it('parity-switches refuses an unregistered model-visible contribution', () => {
    const root = fixtureTree({ 'delo/packages/plugin-fixture/src/index.ts': FIXTURE_PLUGIN })
    const scan = scanParity(root, { registry: [], upstreamChanges: () => 'all' })
    expect(scan.contributions).toEqual([{ path: 'delo/packages/plugin-fixture/src/index.ts', line: 5, api: 'systemPrompt.context' }])
    expect(scan.errors).toContain('delo/packages/plugin-fixture/src/index.ts:5: systemPrompt.context is a model-visible contribution that no built C16 switch turns off; register the switch in PARITY_SWITCHES with this file in its sources')
  })

  it('accepts the same contribution once a built switch lists its file', () => {
    const registry = registryOver(['delo/packages/plugin-fixture/src/index.ts'])
    const found = findContributions('delo/packages/plugin-fixture/src/index.ts', FIXTURE_PLUGIN, 'all')
    expect(contributionErrors(found, registry)).toEqual([])
    expect(contributionErrors(found, [{ ...registry[0] as BuiltParitySwitch, modelVisible: false }])).toHaveLength(1)
  })

  it('counts each registration API and model-visible listener, and no other call', () => {
    const text = [
      'export function apply(ctx) {',
      '  ctx.tools.register(defineTool({ name: "x" }))',
      '  ctx.systemPrompt.section({ name: "s" })',
      '  ctx.on("tools/result", (result, next) => next())',
      '  ctx.on("session/created", () => {})',
      '  ctx.logger.info("x")',
      '}',
    ].join('\n')
    expect(findContributions('delo/x/src/a.ts', text, 'all').map(found => found.api)).toEqual(['tools.register', 'defineTool', 'systemPrompt.section', 'on(\'tools/result\')'])
  })

  it('counts an upstream edit only on a changed line in a top-level statement that registers a contribution', () => {
    const text = [
      'const LABEL = "a"',
      'export function apply(ctx) {',
      '  const description = "b"',
      '  ctx.tools.register(defineTool({ name: "x", description }))',
      '}',
      'function render() { return "c" }',
    ].join('\n')
    expect(findContributions('packages/x/src/a.ts', text, new Set([1, 6]))).toEqual([])
    expect(findContributions('packages/x/src/a.ts', text, new Set([3]))).toEqual([{ path: 'packages/x/src/a.ts', line: 3, api: 'tools.register, defineTool' }])
  })

  it('reads the new-file lines of a zero-context diff, a pure deletion as the line before it', () => {
    expect([...changedLines('@@ -3,0 +4,2 @@\n+a\n+b\n@@ -10 +12 @@\n-c\n+d\n@@ -20,2 +21,0 @@\n-e\n-f\n')]).toEqual([4, 5, 12, 21])
  })
})

describe('the parity overlay', () => {
  it('sets each switch a row can reach to its parity value and names the reason for every other built switch', () => {
    const rows = parseOverlay(readFileSync(join(ROOT, PARITY_OVERLAY_PATH), 'utf8'))
    expect(overlayErrors(rows, PARITY_SWITCHES)).toEqual([])
    expect(rows).toEqual([{ id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools', config: { readActionsExempt: false, profileHistory: false } }])
    expect(Object.keys(DEFAULT_PARITY).sort()).toEqual(['container_denial_marker', 'doctor', 'fetch_guard', 'preset_inspect', 'sandbox_protected_reads', 'studio_additions'])
  })

  it('fails a switch left on, a key that is no switch, and a row that sets more than config', () => {
    const row = { id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools' }
    expect(overlayErrors([{ ...row, config: { readActionsExempt: false, profileHistory: true } }], PARITY_SWITCHES)).toEqual([
      'parity overlay row tool-plugin-manager: profileHistory is true, not the parity value of profile_history (false)',
    ])
    expect(overlayErrors([{ ...row, config: { readActionsExempt: false, profileHistory: false, extra: 1 } }], PARITY_SWITCHES)).toEqual([
      'parity overlay row tool-plugin-manager: extra is not a C16 switch of @deepseek-ai/dsh-plugin-manager/tools',
    ])
    expect(overlayErrors([], PARITY_SWITCHES)).toEqual([
      'plugin_manager_read_exemption: the overlay does not set it; add a row, or list it in DEFAULT_PARITY with the reason a row cannot',
      'profile_history: the overlay does not set it; add a row, or list it in DEFAULT_PARITY with the reason a row cannot',
    ])
    expect(() => parseOverlay('- id: tool-plugin-manager\n  name: x\n  disabled: true\n  config: {}\n')).toThrow('sets disabled')
  })
})

describe('the parity overlay\'s mount of @delo/bundle-local', () => {
  const bundle = readFileSync(join(ROOT, LOCAL_BUNDLE_PATCH_PATH), 'utf8')

  it('restates the bundle\'s patch in its parity form', () => {
    const { localBundle } = readOverlay(readFileSync(join(ROOT, PARITY_OVERLAY_PATH), 'utf8'))
    expect(localBundleErrors(localBundle, bundle)).toEqual([])
    expect(localBundle).toEqual([
      { id: 'product-analytics', config: { enabled: false, appVersion: { __jsExpr: 'process.env.DSH_CLIENT_VERSION' } } },
      { insert: [{ id: 'delo-privacy', name: '@delo/bundle-local', disabled: true }] },
    ])
  })

  it('fails a missing bundle row, a restated row whose parity form is upstream\'s, and an unlisted bundle row', () => {
    const { localBundle } = readOverlay(readFileSync(join(ROOT, PARITY_OVERLAY_PATH), 'utf8'))
    expect(localBundleErrors(localBundle.slice(0, 1), bundle)).toEqual([
      'parity overlay: @delo/bundle-local patch 1 is nothing, not its parity form {"insert":[{"id":"delo-privacy","name":"@delo/bundle-local","disabled":true}]}',
    ])
    // The session-log row's parity form is upstream's composition, so restating it overrides the replay's root configuration.
    expect(localBundleErrors([{ id: 'session-log-deepseek', config: { enabled: false } }, ...localBundle], bundle)).toEqual([
      'parity overlay: @delo/bundle-local patch 0 is {"id":"session-log-deepseek","config":{"enabled":false}}, not its parity form {"id":"product-analytics","config":{"enabled":false,"appVersion":{"__jsExpr":"process.env.DSH_CLIENT_VERSION"}}}',
      'parity overlay: @delo/bundle-local patch 1 is {"id":"product-analytics","config":{"enabled":false,"appVersion":{"__jsExpr":"process.env.DSH_CLIENT_VERSION"}}}, not its parity form {"insert":[{"id":"delo-privacy","name":"@delo/bundle-local","disabled":true}]}',
      'parity overlay: @delo/bundle-local patch 2 is {"insert":[{"id":"delo-privacy","name":"@delo/bundle-local","disabled":true}]}, not its parity form nothing',
    ])
    expect(localBundleErrors(localBundle, `${bundle}\n- id: web-search-deepseek\n  config: {}\n`)).toEqual([
      `${LOCAL_BUNDLE_PATCH_PATH}: @delo/bundle-local writes row "web-search-deepseek", which LOCAL_ROWS does not list`,
    ])
  })
})

describe('the switch sweep', () => {
  const entry = registryOver(['delo/packages/plugin-fixture/src/index.ts'])[0] as BuiltParitySwitch
  const listing = (dirs: Record<string, string[]>) => ({ list: (dir: string) => dirs[dir] })

  it('reports a staged scenario as pending recording, never as passing, and a recorded one as replayed by parity-replay', () => {
    const pending = sweep([entry], listing({ [`${STAGED_ROOT}/session/delo-fixture-context`]: ['runtime.cordis.yml', 'snapshot.yml'], [STAGED_ROOT]: ['session'], [`${STAGED_ROOT}/session`]: ['delo-fixture-context'] }))
    expect(pending.errors).toEqual([])
    expect(pending.rows.map(sweepLine)).toEqual([`fixture_context: pending recording (${STAGED_ROOT}/session/delo-fixture-context)`])
    const recorded = sweep([entry], listing({ 'snapshots/session/delo-fixture-context': ['runtime.cordis.yml', 'session.v4.jsonl', 'snapshot.yml'] }))
    expect(recorded).toEqual({ rows: [{ id: 'fixture_context', state: { kind: 'recorded', scenario: 'session/delo-fixture-context' } }], errors: [] })
  })

  it('fails a model-visible switch with no scenario, a staged one without its layer, and a staged directory no switch names', () => {
    expect(sweep([entry], listing({})).errors).toEqual([`fixture_context: no switch-on scenario at snapshots/session/delo-fixture-context and no staged configuration at ${STAGED_ROOT}/session/delo-fixture-context`])
    expect(sweep([entry], listing({ [`${STAGED_ROOT}/session/delo-fixture-context`]: ['snapshot.yml'] })).errors).toEqual([`fixture_context: ${STAGED_ROOT}/session/delo-fixture-context has no runtime.cordis.yml`])
    expect(sweep([], listing({ [STAGED_ROOT]: ['session'], [`${STAGED_ROOT}/session`]: ['delo-stray'] })).errors).toEqual([`${STAGED_ROOT}/session/delo-stray is the scenario of no built, model-visible switch`])
  })
})
