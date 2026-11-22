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
import { PARITY_OVERLAY_PATH, PARITY_SWITCHES, type BuiltParitySwitch, type ParitySwitchEntry } from '@delorun/contract-parity-composition'
import { BASE_PATCH_PATH, compositionSettings, report, scanParity, STUDIO_BUNDLE_PATCH_PATH } from '../../src/parity/composition/check-parity-switches.ts'
import { contributionErrors, diffHunks, findContributions, passNonModelVisibleHunks, type DiffHunk } from '../../src/parity/composition/contributions.ts'
import type { NonModelVisibleHunk, Patch } from '../../src/fork-boundary.ts'
import { patchDigest } from '../../src/ledger-digests.ts'
import { DEFAULT_PARITY, LOCAL_BUNDLE_PATCH_PATH, localBundleErrors, overlayErrors, parseOverlay, readOverlay } from '../../src/parity/composition/overlay.ts'
import { presenceErrors, registryErrors, scenarioName, switchMarkers } from '../../src/parity/composition/switches.ts'
import { STAGED_ROOT, sweep, sweepLine } from '../../src/parity/composition/sweep.ts'

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A fixture repository with an empty ledger, the real overlay, the local, studio and base bundles' patches and the given files.
 * @param files - repository paths and their contents.
 * @returns the fixture's root.
 */
function fixtureTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'delorun-parity-'))
  roots.push(root)
  const all: Record<string, string> = {
    'delorun/upstream-patches.json': JSON.stringify({ upstream: { repository: 'r', ref: 't', commit: '0'.repeat(40) }, forkOwned: ['delorun/'], patches: [], retired: [] }),
    [PARITY_OVERLAY_PATH]: readFileSync(join(ROOT, PARITY_OVERLAY_PATH), 'utf8'),
    [LOCAL_BUNDLE_PATCH_PATH]: readFileSync(join(ROOT, LOCAL_BUNDLE_PATCH_PATH), 'utf8'),
    [BASE_PATCH_PATH]: readFileSync(join(ROOT, BASE_PATCH_PATH), 'utf8'),
    [STUDIO_BUNDLE_PATCH_PATH]: readFileSync(join(ROOT, STUDIO_BUNDLE_PATCH_PATH), 'utf8'),
    ...files,
  }
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const FIXTURE_PLUGIN = `import type { Context } from '@deepseek-ai/cordis'

/** A Delorun plugin that adds runtime context to every model request. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.context({ name: 'delorun:fixture', order: 0, text: () => 'planted' })
}
`

/** A registry with one built, model-visible switch over the given sources and no planned entry. */
function registryOver(sources: string[]): ParitySwitchEntry[] {
  return [{
    id: 'fixture_context', state: 'built', registeredBy: 'fixture', defaultValue: true, parityValue: false, modelVisible: true,
    scenario: 'session/delorun-fixture-context', field: { module: '@delorun/plugin-fixture', source: 'delorun/packages/plugin-fixture/src/config.ts', key: 'fixtureContext' }, sources,
  }]
}

const FIXTURE_CONFIG = `/** The fixture's switch. */
export interface Config {
  /** Add the context. This is Delorun's C16 switch \`fixture_context\`, off in the parity composition. */
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
    for (const entry of built as readonly BuiltParitySwitch[]) {
      // A presence switch's key declares no boolean default; a boolean switch's default is its parity value.
      const defaultValue = entry.field.kind === 'presence' ? undefined : entry.parityValue
      expect(scan.markers.find(marker => marker.id === entry.id)).toMatchObject({ path: entry.field.source, key: entry.field.key, defaultValue })
    }
    // Every model-visible contribution must sit in a built switch's sources. A
    // switch may also name a file whose runtime behaviour it gates when the
    // visible effect is a tool result text rather than a registration (the
    // fetch guard's refusal flows through the provider's error; the MCP
    // consent's gate holds the server stopped before its tools register), so
    // the sources union is a superset, never a subset.
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

  it('declares the value the shipped composition gives every switch its rows set', () => {
    // `defaultValue` is what Delorun's default composition does, and the Config default is the parity value. Nothing held
    // the two together: this switch's entry claimed the change was on while no shipped row set it, so the search tools
    // kept their stock behaviour in the composition Delorun ships. The shipped rows are where the claim is made.
    const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
    const { shipped, parity } = compositionSettings(read, readOverlay(read(PARITY_OVERLAY_PATH)))
    const registry = PARITY_SWITCHES as readonly ParitySwitchEntry[]
    const covered = registry.filter((entry): entry is BuiltParitySwitch => entry.state === 'built' && entry.field.kind !== 'presence').flatMap(entry => shipped
      .filter(row => row.module === entry.field.module && row.key === entry.field.key)
      .map(row => ({ id: entry.id, value: row.value, declared: entry.defaultValue })))
    // A row may be restated per profile; one switch is still one claim. The consent plugins and the update gate are
    // inserted rows, which carry their module as `name`.
    expect([...new Set(covered.map(({ id }) => id))].sort()).toEqual([
      'approved_plugin_write_consent', 'external_agent_consent', 'external_agent_limit_refusal', 'fetch_guard', 'instruction_layer_consent', 'live_agents', 'mcp_add_consent', 'model_prompt', 'one_time_launch_tokens', 'permission_defaults',
      'plugin_changes_pending', 'reach', 'rename_workspace_tool', 'scheduled_task_consent', 'studio_additions', 'tool_failure_guard', 'update_check', 'update_turn_refusal',
    ])
    for (const { id, value, declared } of covered) expect(value, id).toBe(declared)
    expect(presenceErrors(registry, shipped, parity)).toEqual([])
    // The fence, spelled out: the sandbox row's protected home is set in the composition Delorun ships and not in the
    // parity composition.
    expect(registry.find(entry => entry.id === 'sandbox_protected_reads')).toMatchObject({
      state: 'built', defaultValue: true, parityValue: false,
      field: { kind: 'presence', module: '@deepseek-ai/dsh-sandbox-local', key: 'protectedHome' },
    })
  })
})

describe('the switch fields', () => {
  it('reads the switch id, the key and the schema default of each marked Config field', () => {
    expect(switchMarkers('delorun/packages/plugin-fixture/src/config.ts', FIXTURE_CONFIG)).toEqual([
      { path: 'delorun/packages/plugin-fixture/src/config.ts', line: 4, id: 'fixture_context', key: 'fixtureContext', defaultValue: false },
    ])
  })

  it('reads the fields of the interface a Config schema is typed by', () => {
    const text = [
      'export interface ConnectionConfig {',
      '  /** C16 switch `fixture_context`: on in Delorun. */',
      '  fixtureContext?: boolean',
      '}',
      'export interface Unrelated {',
      '  /** C16 switch `other_context`. */',
      '  otherContext?: boolean',
      '}',
      'export const Config: z<ConnectionConfig> = z.object({ fixtureContext: z.boolean().default(false) })',
      'const Other: z<Unrelated> = z.object({})',
      // Neither names an interface: no annotation, no type argument, a type literal, a qualified name, a pattern.
      'const Config = 1',
      'const Config: Schema = 1',
      'const Config: z<{ a: 1 }> = 1',
      'const Config: z<ns.Unrelated> = 1',
      'const { Config } = schemas',
      '',
    ].join('\n')
    expect(switchMarkers('packages/fixture/src/index.ts', text)).toEqual([
      { path: 'packages/fixture/src/index.ts', line: 3, id: 'fixture_context', key: 'fixtureContext', defaultValue: false },
    ])
  })

  it('reads the fields of the interfaces a Config union alias names and of those they extend in the same file', () => {
    const text = [
      'export interface Additions {',
      '  /** C16 switch `fixture_context`: on in Delorun. */',
      '  fixtureContext: boolean',
      '}',
      'export interface Unrelated {',
      '  /** C16 switch `other_context`. */',
      '  otherContext?: boolean',
      '}',
      'export interface LaunchConfig extends Shared, Additions { mode: \'launch\' }',
      'export interface AttachConfig extends Shared, Additions { mode: \'attach\' }',
      'export type Config = LaunchConfig | AttachConfig',
      'export const Config = Schema.union([Schema.object({ fixtureContext: Schema.boolean().default(false) })])',
      '',
    ].join('\n')
    expect(switchMarkers('packages/fixture/src/index.ts', text)).toEqual([
      { path: 'packages/fixture/src/index.ts', line: 3, id: 'fixture_context', key: 'fixtureContext', defaultValue: false },
    ])
  })

  it('fails a Config field marked as a switch that the registry lacks', () => {
    const markers = switchMarkers('delorun/packages/plugin-fixture/src/config.ts', FIXTURE_CONFIG)
    expect(registryErrors([], markers, () => true)).toEqual([
      'delorun/packages/plugin-fixture/src/config.ts:4: Config field fixtureContext names C16 switch fixture_context, which is not in PARITY_SWITCHES',
    ])
  })

  it('fails a built entry whose field the tree lacks, and one whose default is not its parity value', () => {
    expect(registryErrors(registryOver(['delorun/packages/plugin-fixture/src/config.ts']), [], () => true)).toEqual([
      'fixture_context: delorun/packages/plugin-fixture/src/config.ts has no Config field fixtureContext whose JSDoc names C16 switch `fixture_context`',
    ])
    const onByDefault = switchMarkers('delorun/packages/plugin-fixture/src/config.ts', FIXTURE_CONFIG.replace('.default(false)', '.default(true)'))
    expect(registryErrors(registryOver(['delorun/packages/plugin-fixture/src/config.ts']), onByDefault, () => true)).toEqual([
      'fixture_context: the Config default of fixtureContext is true, not the parity value false',
    ])
  })

  it('fails a planned entry once its switch field exists, so the entry becomes built with that field', () => {
    const planned: ParitySwitchEntry = { id: 'fixture_context', state: 'planned', plannedBy: 'WP0', registeredBy: 'fixture', defaultValue: true, parityValue: false, modelVisible: true, scenario: 'session/delorun-fixture-context' }
    const markers = switchMarkers('delorun/packages/plugin-fixture/src/config.ts', FIXTURE_CONFIG)
    expect(registryErrors([planned], markers, () => true)).toEqual([
      'delorun/packages/plugin-fixture/src/config.ts:4: Config field fixtureContext names C16 switch fixture_context, whose registry entry is still planned; make it built with this field',
    ])
  })
})

const PRESENCE_SOURCE = 'packages/sandbox/fixture/src/index.ts'

/** A provider Config whose `home` key is a presence switch: the JSDoc names it, and the schema declares no default. */
const PRESENCE_CONFIG = `/** The fixture provider's settings. */
export interface Config {
  /** The protected directory. Its presence is Delorun's C16 switch \`fixture_home\`. */
  home?: string
}

export const Config = z.object({
  home: z.string(),
})
`

/**
 * A registry with one built presence switch on the fixture provider's \`home\` key.
 * @param values - the default and parity values, `true` and `false` unless given.
 * @returns the registry.
 */
function presenceRegistry(values: { defaultValue?: boolean; parityValue?: boolean } = {}): ParitySwitchEntry[] {
  return [{
    id: 'fixture_home', state: 'built', registeredBy: 'fixture', defaultValue: values.defaultValue ?? true, parityValue: values.parityValue ?? false,
    modelVisible: true, scenario: 'session/delorun-fixture-home', field: { kind: 'presence', module: '@fixture/provider', source: PRESENCE_SOURCE, key: 'home' }, sources: [PRESENCE_SOURCE],
  }]
}

describe('a presence switch', () => {
  const markers = switchMarkers(PRESENCE_SOURCE, PRESENCE_CONFIG)
  const shipped = [{ module: '@fixture/provider', key: 'home', value: { __jsExpr: 'dshHomePath()' } }]

  it('is accepted when the JSDoc names it, the default composition sets the key and the parity composition does not', () => {
    expect(markers).toEqual([{ path: PRESENCE_SOURCE, line: 4, id: 'fixture_home', key: 'home', defaultValue: undefined }])
    expect(registryErrors(presenceRegistry(), markers, () => true)).toEqual([])
    expect(presenceErrors(presenceRegistry(), shipped, [{ module: '@fixture/provider', key: 'other', value: 1 }])).toEqual([])
  })

  it('is refused when the default composition does not set the key, or leaves it null or undefined', () => {
    const refusal = 'fixture_home: Delorun\'s default composition sets no home on a @fixture/provider row, so the switch is off where it is declared on'
    expect(presenceErrors(presenceRegistry(), [], [])).toEqual([refusal])
    expect(presenceErrors(presenceRegistry(), [{ module: '@fixture/provider', key: 'home', value: null }], [])).toEqual([refusal])
    expect(presenceErrors(presenceRegistry(), [{ module: '@fixture/provider', key: 'home', value: undefined }], [])).toEqual([refusal])
    expect(presenceErrors(presenceRegistry(), [{ module: '@fixture/other', key: 'home', value: '/h' }], [])).toEqual([refusal])
  })

  it('is refused when the parity composition sets the key', () => {
    expect(presenceErrors(presenceRegistry(), shipped, shipped)).toEqual([
      'fixture_home: the parity composition sets home on a @fixture/provider row, so the switch is on where its parity value is off',
    ])
  })

  it('is refused when the JSDoc marker is missing, or the key declares a boolean default', () => {
    expect(registryErrors(presenceRegistry(), switchMarkers(PRESENCE_SOURCE, PRESENCE_CONFIG.replace(' Its presence is Delorun\'s C16 switch `fixture_home`.', '')), () => true)).toEqual([
      `fixture_home: ${PRESENCE_SOURCE} has no Config field home whose JSDoc names C16 switch \`fixture_home\``,
    ])
    expect(registryErrors(presenceRegistry(), switchMarkers(PRESENCE_SOURCE, PRESENCE_CONFIG.replace('z.string()', 'z.boolean().default(false)')), () => true)).toEqual([
      `fixture_home: ${PRESENCE_SOURCE} declares a boolean schema default for home, which a presence switch leaves unset`,
    ])
  })

  it('is refused unless it is on by default and off at parity', () => {
    const refusal = 'fixture_home: a presence switch is on where its key is set, so its default value is true and its parity value false'
    expect(registryErrors(presenceRegistry({ defaultValue: false, parityValue: true }), markers, () => true)).toEqual([refusal])
    expect(registryErrors(presenceRegistry({ parityValue: true }), markers, () => true)).toContain(refusal)
  })

  it('leaves the boolean switches to their own checks', () => {
    expect(presenceErrors(registryOver([]), [], [])).toEqual([])
    const planned: ParitySwitchEntry = { id: 'fixture_context', state: 'planned', plannedBy: 'WP0', registeredBy: 'fixture', defaultValue: true, parityValue: false, modelVisible: true, scenario: 'session/delorun-fixture-context' }
    expect(presenceErrors([planned], [], [])).toEqual([])
  })
})

describe('parity-switches on a presence switch', () => {
  /** A presence switch on the sandbox row's given key, with the fixture provider Config as its field's source. */
  const sandboxRegistry = (key: string): ParitySwitchEntry[] => [{
    id: 'fixture_home', state: 'built', registeredBy: 'fixture', defaultValue: true, parityValue: false, modelVisible: true,
    scenario: 'session/delorun-fixture-home', field: { kind: 'presence', module: '@deepseek-ai/dsh-sandbox-local', source: PRESENCE_SOURCE, key }, sources: [PRESENCE_SOURCE],
  }]
  const config = (key: string): string => PRESENCE_CONFIG.replace('  home?: string', `  ${key}?: string`).replace('  home: z.string()', `  ${key}: z.string()`)

  it('holds the key against the rows @delorun/bundle-local and the parity overlay set', () => {
    const root = fixtureTree({ [PRESENCE_SOURCE]: config('protectedHome') })
    const options = { registry: sandboxRegistry('protectedHome'), upstreamChanges: () => 'all' as const }
    // The fixture switch has no overlay reason and no scenario, which other checks report; the presence rule is silent.
    expect(scanParity(root, options).errors.filter(error => error.includes('composition sets'))).toEqual([])
  })

  it('refuses a key Delorun\'s default composition does not set', () => {
    const root = fixtureTree({ [PRESENCE_SOURCE]: config('unsetKey') })
    expect(scanParity(root, { registry: sandboxRegistry('unsetKey'), upstreamChanges: () => 'all' }).errors).toContain(
      'fixture_home: Delorun\'s default composition sets no unsetKey on a @deepseek-ai/dsh-sandbox-local row, so the switch is off where it is declared on',
    )
  })

  it('reports a composition it cannot read', () => {
    const root = fixtureTree({ [PRESENCE_SOURCE]: config('protectedHome') })
    rmSync(join(root, BASE_PATCH_PATH))
    const errors = scanParity(root, { registry: sandboxRegistry('protectedHome'), upstreamChanges: () => 'all' }).errors
    expect(errors.filter(error => error.startsWith('parity compositions: '))).toHaveLength(1)
  })

  it('leaves the presence rule out when the overlay cannot be read', () => {
    const root = fixtureTree({ [PRESENCE_SOURCE]: config('unsetKey'), [PARITY_OVERLAY_PATH]: 'not: a list\n' })
    const errors = scanParity(root, { registry: sandboxRegistry('unsetKey'), upstreamChanges: () => 'all' }).errors
    expect(errors.some(error => error.startsWith(`${PARITY_OVERLAY_PATH}: `))).toBe(true)
    expect(errors.filter(error => error.includes('composition sets') || error.startsWith('parity compositions: '))).toEqual([])
  })
})

describe('the model-visible contributions', () => {
  it('parity-switches refuses an unregistered model-visible contribution', () => {
    const root = fixtureTree({ 'delorun/packages/plugin-fixture/src/index.ts': FIXTURE_PLUGIN })
    const scan = scanParity(root, { registry: [], upstreamChanges: () => 'all' })
    expect(scan.contributions).toEqual([{ path: 'delorun/packages/plugin-fixture/src/index.ts', line: 5, api: 'systemPrompt.context' }])
    expect(scan.errors).toContain('delorun/packages/plugin-fixture/src/index.ts:5: systemPrompt.context is a model-visible contribution that no built C16 switch turns off; register the switch in PARITY_SWITCHES with this file in its sources')
  })

  it('accepts the same contribution once a built switch lists its file', () => {
    const registry = registryOver(['delorun/packages/plugin-fixture/src/index.ts'])
    const found = findContributions('delorun/packages/plugin-fixture/src/index.ts', FIXTURE_PLUGIN, 'all')
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
    expect(findContributions('delorun/x/src/a.ts', text, 'all').map(found => found.api)).toEqual(['tools.register', 'defineTool', 'systemPrompt.section', 'on(\'tools/result\')'])
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
    expect(findContributions('packages/x/src/a.ts', text, new Set([4, 3]))).toEqual([{ path: 'packages/x/src/a.ts', line: 3, api: 'tools.register, defineTool', lines: [3, 4] }])
  })

  it('reads each hunk of a zero-context diff at the lines it adds, a deletion-only hunk at the line before it', () => {
    const hunks = diffHunks('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -3,0 +4,2 @@\n+a\n+b\n@@ -10 +12 @@ fn()\n-c\n+d\n@@ -20,2 +21,0 @@\n-e\n-f\n@@ -1 +0,0 @@\n-g\n')
    expect(hunks.map(hunk => hunk.lines)).toEqual([[4, 5], [12], [21], [1]])
    expect(diffHunks('')).toEqual([])
  })

  it('digests a hunk\'s counts and marked lines, not its start lines or function context', () => {
    const [hunk] = diffHunks('@@ -10 +12 @@ fn()\n-c\n+d\n\\ No newline at end of file\n')
    expect(hunk?.sha256).toBe(patchDigest('@@ -1 +1 @@\n-c\n+d\n\\ No newline at end of file\n'))
    expect(diffHunks('@@ -40,1 +2 @@ other()\n-c\n+d\n\\ No newline at end of file\n')[0]?.sha256).toBe(hunk?.sha256)
    expect(diffHunks('@@ -10 +12 @@\n-c\n+d\n')[0]?.sha256).not.toBe(hunk?.sha256)
    expect(diffHunks('@@ -10 +12 @@\n-c\n+ d\n')[0]?.sha256).not.toBe(diffHunks('@@ -10 +12 @@\n-c\n+d\n')[0]?.sha256)
  })
})

describe('a security entry\'s non-model-visible hunk records', () => {
  const FILE = 'packages/x/src/index.ts'
  /** The fork's file; lines 5 and 8 hold the same text. */
  const APPLY = [
    'export function apply(ctx) {',
    '  const git = confined(runner())',
    '  ctx.on("tools/pre-execute", (call, next) => {',
    '    check(call)',
    '  })',
    '  ctx.on("tools/result", (result, next) => {',
    '    render(result)',
    '  })',
    '}',
    'export const unrelated = 1',
    '',
  ].join('\n')
  const GIT = '@@ -2 +2 @@\n-  const git = runner()\n+  const git = confined(runner())\n'
  const CHECK = '@@ -4 +4 @@\n-    check()\n+    check(call)\n'
  const UNRELATED = '@@ -10 +10 @@\n-export const unrelated = 0\n+export const unrelated = 1\n'
  const POST_EXECUTE = '-  ctx.on("tools/post-execute", (call, next) => next())\n'
  const record = (diff: string): NonModelVisibleHunk => ({ sha256: diffHunks(diff)[0]?.sha256 ?? '', reason: 'reviewed' })

  /**
   * Scan a fixture whose ledger lists {@link FILE} with the given entry fields, against an empty registry.
   * @param entry - the entry's class and records.
   * @param edited - the file's diff, or `all`.
   * @returns the errors the scan reports for {@link FILE}.
   */
  function scan(entry: Partial<Patch>, edited: 'all' | string): string[] {
    const patch = { path: FILE, class: 'security', reason: 'confines git', sha256: patchDigest(APPLY), ...entry }
    const ledger = { upstream: { repository: 'r', ref: 't', commit: '0'.repeat(40) }, forkOwned: ['delorun/'], patches: [patch], retired: [] }
    const root = fixtureTree({ [FILE]: APPLY, 'delorun/upstream-patches.json': JSON.stringify(ledger) })
    const hunks: 'all' | DiffHunk[] = edited === 'all' ? 'all' : diffHunks(edited)
    return scanParity(root, { registry: [], upstreamChanges: () => hunks }).errors.filter(error => error.startsWith(FILE))
  }
  const uncovered = (line: number, api = 'on(\'tools/pre-execute\'), on(\'tools/result\')'): string =>
    `${FILE}:${String(line)}: ${api} is a model-visible contribution that no built C16 switch turns off; register the switch in PARITY_SWITCHES with this file in its sources`
  const stale = (diff: string): string =>
    `${FILE}: the non-model-visible hunk record ${record(diff).sha256} matches no hunk of the edit in a statement that registers a model-visible contribution; it is stale, so remove it`

  it('passes a recorded hunk in a registering statement, and counts it again once the hunk changes', () => {
    expect(scan({}, GIT)).toEqual([uncovered(2)])
    expect(scan({ nonModelVisibleHunks: [record(GIT)] }, GIT)).toEqual([])
    expect(scan({ nonModelVisibleHunks: [record(GIT)] }, GIT.replace('confined(runner())', 'confined(other())'))).toEqual([uncovered(2), stale(GIT)])
  })

  it('keeps passing a recorded hunk that an edit elsewhere shifts', () => {
    expect(scan({ nonModelVisibleHunks: [record(GIT)] }, GIT.replace('@@ -2 +2 @@', '@@ -7 +2 @@ export function apply(ctx) {'))).toEqual([])
  })

  it('fails a record that matches no hunk in a registering statement as stale', () => {
    expect(scan({ nonModelVisibleHunks: [record(UNRELATED)] }, UNRELATED)).toEqual([stale(UNRELATED)])
  })

  it('still counts an unrecorded hunk in the statement that holds a recorded one', () => {
    expect(scan({ nonModelVisibleHunks: [record(GIT)] }, GIT + CHECK)).toEqual([uncovered(4)])
  })

  it('does not pass a deleted registration call unless that exact hunk is recorded', () => {
    const merged = GIT.replace('@@ -2 +2 @@', '@@ -2,2 +2 @@').replace('+  const', `${POST_EXECUTE}+  const`)
    expect(scan({ nonModelVisibleHunks: [record(GIT)] }, merged)).toEqual([uncovered(2), stale(GIT)])
    expect(scan({ nonModelVisibleHunks: [record(merged)] }, merged)).toEqual([])
    const replaced = GIT.replace('-  const git = runner()\n', POST_EXECUTE)
    expect(scan({ nonModelVisibleHunks: [record(GIT)] }, replaced)).toEqual([uncovered(2), stale(GIT)])
    const deletion = `@@ -3 +2,0 @@\n${POST_EXECUTE}`
    expect(scan({ nonModelVisibleHunks: [record(GIT)] }, GIT + deletion)).toEqual([uncovered(2)])
    expect(scan({ nonModelVisibleHunks: [record(GIT), record(deletion)] }, GIT + deletion)).toEqual([])
  })

  it('lets one record pass one hunk, so a record does not cover a second hunk with the same lines', () => {
    const first = '@@ -5 +5 @@\n-  }\n+  })\n'
    const second = '@@ -8 +8 @@\n-  }\n+  })\n'
    expect(record(first)).toEqual(record(second))
    expect(scan({ nonModelVisibleHunks: [record(first)] }, first + second)).toEqual([
      uncovered(5),
      `${FILE}: 1 non-model-visible hunk record(s) ${record(first).sha256} for 2 hunk(s) with that digest, read at line(s) 5, 8; each hunk needs one record, which \`ledger-record.ts --non-model-visible-hunk\` writes`,
    ])
    expect(scan({ nonModelVisibleHunks: [record(first), record(second)] }, first + second)).toEqual([])
  })

  it('passes nothing for a file the pinned commit lacks, whose every contribution counts', () => {
    expect(scan({ nonModelVisibleHunks: [record(GIT)] }, 'all')).toEqual([
      uncovered(3, 'on(\'tools/pre-execute\')'),
      uncovered(6, 'on(\'tools/result\')'),
      stale(GIT),
    ])
  })

  it('passes nothing for the records of an entry that is not of class security', () => {
    expect(scan({ class: 'generic-fix', feature: 'f', nonModelVisibleHunks: [record(GIT)] }, GIT)).toEqual([uncovered(2)])
  })

  it('fails records on a ledgered file whose contributions it does not read', () => {
    const root = fixtureTree({
      'delorun/upstream-patches.json': JSON.stringify({
        upstream: { repository: 'r', ref: 't', commit: '0'.repeat(40) }, forkOwned: ['delorun/'], retired: [],
        patches: [{ path: 'docs/a.md', class: 'security', reason: 'r', sha256: patchDigest('a'), nonModelVisibleHunks: [record(GIT)] }],
      }),
    })
    expect(scanParity(root, { registry: [], upstreamChanges: () => 'all' }).errors).toContain(
      'docs/a.md: records `nonModelVisibleHunks`, but parity-switches reads no contributions in this file; remove them',
    )
  })

  it('keeps the contributions as they are when the entry records no hunk', () => {
    const found = findContributions(FILE, APPLY, new Set([2]))
    expect(passNonModelVisibleHunks(FILE, found, diffHunks(GIT), [])).toEqual({ contributions: found, errors: [] })
  })
})

describe('the parity overlay', () => {
  it('sets each switch a row can reach to its parity value and names the reason for every other built switch', () => {
    const rows = parseOverlay(readFileSync(join(ROOT, PARITY_OVERLAY_PATH), 'utf8'))
    expect(overlayErrors(rows, PARITY_SWITCHES)).toEqual([])
    expect(rows).toEqual([{ id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools', config: { readActionsExempt: false, profileHistory: false } }])
    expect(Object.keys(DEFAULT_PARITY).sort()).toEqual([
      'approved_plugin_write_consent', 'browser_additions', 'container_denial_marker', 'default_workspace_directory', 'doctor', 'external_agent_consent', 'external_agent_limit_refusal', 'fetch_guard', 'instruction_layer_consent', 'live_agents',
      'main_chat', 'mcp_add_consent', 'model_prompt', 'one_time_launch_tokens', 'permission_defaults', 'plugin_changes_pending', 'preset_inspect', 'reach', 'rename_workspace_tool', 'sandbox_protected_reads',
      'scheduled_task_consent', 'studio_additions', 'tool_failure_guard', 'update_check', 'update_turn_refusal', 'use_my_browser',
    ])
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

describe('the parity overlay\'s mount of @delorun/bundle-local', () => {
  const bundle = readFileSync(join(ROOT, LOCAL_BUNDLE_PATCH_PATH), 'utf8')
  /** The bundles the plugin-changes row names for safe mode from the studio. */
  const CHANGES_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@delorun/bundle-local', '@delorun/bundle-studio']
  /** The six consent and guard rows in the parity form the overlay's third patch restates them. */
  /** The tool-failure guard's row config, as the bundle writes it. */
  const GUARD_CONFIG = { enabled: true, consecutiveFailures: 6, windowSize: 12, windowFailures: 8, reminderAfter: 3, exclude: [] }
  const CONSENT_INSERT = {
    insert: [
      { id: 'delorun-instruction-consent', name: '@delorun/plugin-instruction-consent', config: { enabled: true, approvedPluginWrites: true }, disabled: true },
      { id: 'delorun-mcp-consent', name: '@delorun/plugin-mcp-consent', config: { enabled: true }, disabled: true },
      { id: 'delorun-permission-defaults', name: '@delorun/plugin-permission-defaults', config: { enabled: true }, disabled: true },
      { id: 'delorun-schedule-consent', name: '@delorun/plugin-schedule-consent', config: { enabled: true }, disabled: true },
      { id: 'delorun-fetch-guard', name: '@delorun/plugin-fetch-guard', config: { enabled: true }, disabled: true },
      { id: 'delorun-tool-failure-guard', name: '@delorun/plugin-tool-failure-guard', config: GUARD_CONFIG, disabled: true },
      { id: 'delorun-plugin-authoring', name: '@delorun/skill-plugin-authoring', disabled: true },
      { id: 'delorun-report-problem', name: '@delorun/skill-report-problem', disabled: true },
      { id: 'delorun-delegation-consent', name: '@delorun/plugin-delegation-consent', config: { enabled: true }, disabled: true },
      { id: 'delorun-external-agents', name: '@delorun/external-agents', config: { maxLivePrograms: 4, graceMs: 3000, probeMinIntervalMinutes: 30, probeTriggers: ['pack-added', 'signed-in', 'check-now'], limitRefusal: true }, disabled: true },
      { id: 'delorun-agent-claude-code', name: '@delorun/agent-claude-code', config: { harnessToolTimeoutSeconds: 900 }, disabled: true },
      { id: 'delorun-agent-codex', name: '@delorun/agent-codex', config: { harnessToolTimeoutSeconds: 900 }, disabled: true },
      { id: 'delorun-agent-seats', name: '@delorun/plugin-agent-seats', config: { enabled: true }, disabled: true },
      { id: 'delorun-multiview', name: '@delorun/plugin-multiview', disabled: true },
      { id: 'delorun-plugin-changes', name: '@delorun/plugin-changes', config: { enabled: true, installationBundles: CHANGES_BUNDLES }, disabled: true },
      { id: 'delorun-plugin-update', name: '@delorun/plugin-update', disabled: true },
      { id: 'delorun-packs', name: '@delorun/plugin-packs', config: { concurrency: 2 }, disabled: true },
      { id: 'delorun-workspace-rename', name: '@delorun/bundle-local/workspace-rename', config: { enabled: true }, disabled: true },
      { id: 'delorun-prompt-wording', name: '@delorun/bundle-local/prompt-wording', config: { enabled: true }, disabled: true },
    ],
  }
  /** The update gate row in the parity form the overlay's fourth patch restates it. */
  const GATE_INSERT = { insert: [{ id: 'delorun-update-gate', name: '@delorun/bundle-local/update-gate', config: { enabled: true, holdUntilChecked: true }, disabled: true }] }
  /** The update check row in the parity form the overlay's fifth patch restates it. */
  const CHECK_INSERT = { insert: [{ id: 'delorun-update-check', name: '@delorun/bundle-local/update-check', config: { enabled: true, intervalHours: 24, timeoutSeconds: 15 }, disabled: true }] }
  /** The trust row in the parity form the overlay's sixth patch restates it. */
  const TRUST_INSERT = { insert: [{ id: 'delorun-trust', name: '@delorun/bundle-local/trust', config: { enabled: true }, disabled: true }] }
  const VERSIONS_INSERT = {
    insert: [
      { id: 'delorun-profile-versions', name: '@delorun/bundle-local/profile-versions', disabled: true },
      { id: 'delorun-requirements', name: '@delorun/bundle-local/requirements', disabled: true },
      { id: 'delorun-report', name: '@delorun/bundle-local/report', config: { issueUrl: 'https://github.com/twickas/delorun/issues/new', template: 'bug_report.yml' }, disabled: true },
      { id: 'delorun-run-settings', name: '@delorun/bundle-local/run-settings', disabled: true },
    ],
  }
  /** The plugin install check row in the parity form the overlay's seventh patch restates it. */
  const INSTALL_CHECK_INSERT = { insert: [{ id: 'delorun-plugin-install-check', name: '@delorun/plugin-install-check', config: { enabled: true }, disabled: true }] }
  /** The trash row in the parity form the overlay's eighth patch restates it, with the home paths kept as expressions. */
  const TRASH_INSERT = {
    insert: [{
      id: 'delorun-trash',
      name: '@delorun/plugin-trash',
      config: {
        trashRoot: { __jsExpr: 'dshHomePath(\'trash\')' },
        sessionsRoot: { __jsExpr: 'dshHomePath(\'sessions\')' },
        storagesRoot: { __jsExpr: 'dshHomePath(\'storages\')' },
        attachmentsRoot: { __jsExpr: 'dshHomePath(\'attachments\', \'v1\')' },
        logsHome: { __jsExpr: 'dshHomePath()' },
      },
      disabled: true,
    }],
  }
  /** The home-auth and reach rows in their parity form, which the overlay's ninth patch restates. */
  const REACH_INSERT = {
    insert: [
      { id: 'delorun-home-auth', name: '@delorun/home-auth', config: { secretsDirectory: { __jsExpr: 'dshHomePath(\'secrets\', \'home-auth\')' } }, disabled: true },
      { id: 'delorun-reach', name: '@delorun/reach', config: { enabled: true, tailscalePrivate: { enabled: false, address: '', servePort: 443 } }, disabled: true },
    ],
  }

  it('restates the bundle\'s patch in its parity form', () => {
    const { localBundle } = readOverlay(readFileSync(join(ROOT, PARITY_OVERLAY_PATH), 'utf8'))
    expect(localBundleErrors(localBundle, bundle)).toEqual([])
    expect(localBundle).toEqual([
      { id: 'product-analytics', config: { enabled: false, appVersion: { __jsExpr: 'process.env.DSH_CLIENT_VERSION' } } },
      { insert: [{ id: 'delorun-privacy', name: '@delorun/bundle-local', disabled: true }] },
      {
        insert: [
          { id: 'delorun-instruction-consent', name: '@delorun/plugin-instruction-consent', config: { enabled: true, approvedPluginWrites: true }, disabled: true },
          { id: 'delorun-mcp-consent', name: '@delorun/plugin-mcp-consent', config: { enabled: true }, disabled: true },
          { id: 'delorun-permission-defaults', name: '@delorun/plugin-permission-defaults', config: { enabled: true }, disabled: true },
          { id: 'delorun-schedule-consent', name: '@delorun/plugin-schedule-consent', config: { enabled: true }, disabled: true },
          { id: 'delorun-fetch-guard', name: '@delorun/plugin-fetch-guard', config: { enabled: true }, disabled: true },
          { id: 'delorun-tool-failure-guard', name: '@delorun/plugin-tool-failure-guard', config: GUARD_CONFIG, disabled: true },
          { id: 'delorun-plugin-authoring', name: '@delorun/skill-plugin-authoring', disabled: true },
          { id: 'delorun-report-problem', name: '@delorun/skill-report-problem', disabled: true },
          { id: 'delorun-delegation-consent', name: '@delorun/plugin-delegation-consent', config: { enabled: true }, disabled: true },
          { id: 'delorun-external-agents', name: '@delorun/external-agents', config: { maxLivePrograms: 4, graceMs: 3000, probeMinIntervalMinutes: 30, probeTriggers: ['pack-added', 'signed-in', 'check-now'], limitRefusal: true }, disabled: true },
          { id: 'delorun-agent-claude-code', name: '@delorun/agent-claude-code', config: { harnessToolTimeoutSeconds: 900 }, disabled: true },
          { id: 'delorun-agent-codex', name: '@delorun/agent-codex', config: { harnessToolTimeoutSeconds: 900 }, disabled: true },
          { id: 'delorun-agent-seats', name: '@delorun/plugin-agent-seats', config: { enabled: true }, disabled: true },
          { id: 'delorun-multiview', name: '@delorun/plugin-multiview', disabled: true },
          { id: 'delorun-plugin-changes', name: '@delorun/plugin-changes', config: { enabled: true, installationBundles: CHANGES_BUNDLES }, disabled: true },
          { id: 'delorun-plugin-update', name: '@delorun/plugin-update', disabled: true },
          { id: 'delorun-packs', name: '@delorun/plugin-packs', config: { concurrency: 2 }, disabled: true },
          { id: 'delorun-workspace-rename', name: '@delorun/bundle-local/workspace-rename', config: { enabled: true }, disabled: true },
          { id: 'delorun-prompt-wording', name: '@delorun/bundle-local/prompt-wording', config: { enabled: true }, disabled: true },
        ],
      },
      GATE_INSERT,
      CHECK_INSERT,
      TRUST_INSERT,
      VERSIONS_INSERT,
      INSTALL_CHECK_INSERT,
      TRASH_INSERT,
      REACH_INSERT,
    ])
  })

  it('fails a missing bundle row, a restated row whose parity form is upstream\'s, and an unlisted bundle row', () => {
    const { localBundle } = readOverlay(readFileSync(join(ROOT, PARITY_OVERLAY_PATH), 'utf8'))
    expect(localBundleErrors(localBundle.slice(0, 1), bundle)).toEqual([
      'parity overlay: @delorun/bundle-local patch 1 is nothing, not its parity form {"insert":[{"id":"delorun-privacy","name":"@delorun/bundle-local","disabled":true}]}',
      `parity overlay: @delorun/bundle-local patch 2 is nothing, not its parity form ${JSON.stringify(CONSENT_INSERT)}`,
      `parity overlay: @delorun/bundle-local patch 3 is nothing, not its parity form ${JSON.stringify(GATE_INSERT)}`,
      `parity overlay: @delorun/bundle-local patch 4 is nothing, not its parity form ${JSON.stringify(CHECK_INSERT)}`,
      `parity overlay: @delorun/bundle-local patch 5 is nothing, not its parity form ${JSON.stringify(TRUST_INSERT)}`,
      `parity overlay: @delorun/bundle-local patch 6 is nothing, not its parity form ${JSON.stringify(VERSIONS_INSERT)}`,
      `parity overlay: @delorun/bundle-local patch 7 is nothing, not its parity form ${JSON.stringify(INSTALL_CHECK_INSERT)}`,
      `parity overlay: @delorun/bundle-local patch 8 is nothing, not its parity form ${JSON.stringify(TRASH_INSERT)}`,
      `parity overlay: @delorun/bundle-local patch 9 is nothing, not its parity form ${JSON.stringify(REACH_INSERT)}`,
    ])
    // The session-log row's parity form is upstream's composition, so restating it overrides the replay's root configuration.
    expect(localBundleErrors([{ id: 'session-log-deepseek', config: { enabled: false } }, ...localBundle], bundle)).toEqual([
      'parity overlay: @delorun/bundle-local patch 0 is {"id":"session-log-deepseek","config":{"enabled":false}}, not its parity form {"id":"product-analytics","config":{"enabled":false,"appVersion":{"__jsExpr":"process.env.DSH_CLIENT_VERSION"}}}',
      'parity overlay: @delorun/bundle-local patch 1 is {"id":"product-analytics","config":{"enabled":false,"appVersion":{"__jsExpr":"process.env.DSH_CLIENT_VERSION"}}}, not its parity form {"insert":[{"id":"delorun-privacy","name":"@delorun/bundle-local","disabled":true}]}',
      'parity overlay: @delorun/bundle-local patch 2 is {"insert":[{"id":"delorun-privacy","name":"@delorun/bundle-local","disabled":true}]}, not its parity form ' + JSON.stringify(CONSENT_INSERT),
      `parity overlay: @delorun/bundle-local patch 3 is ${JSON.stringify(CONSENT_INSERT)}, not its parity form ${JSON.stringify(GATE_INSERT)}`,
      `parity overlay: @delorun/bundle-local patch 4 is ${JSON.stringify(GATE_INSERT)}, not its parity form ${JSON.stringify(CHECK_INSERT)}`,
      `parity overlay: @delorun/bundle-local patch 5 is ${JSON.stringify(CHECK_INSERT)}, not its parity form ${JSON.stringify(TRUST_INSERT)}`,
      `parity overlay: @delorun/bundle-local patch 6 is ${JSON.stringify(TRUST_INSERT)}, not its parity form ${JSON.stringify(VERSIONS_INSERT)}`,
      `parity overlay: @delorun/bundle-local patch 7 is ${JSON.stringify(VERSIONS_INSERT)}, not its parity form ${JSON.stringify(INSTALL_CHECK_INSERT)}`,
      `parity overlay: @delorun/bundle-local patch 8 is ${JSON.stringify(INSTALL_CHECK_INSERT)}, not its parity form ${JSON.stringify(TRASH_INSERT)}`,
      `parity overlay: @delorun/bundle-local patch 9 is ${JSON.stringify(TRASH_INSERT)}, not its parity form ${JSON.stringify(REACH_INSERT)}`,
      `parity overlay: @delorun/bundle-local patch 10 is ${JSON.stringify(REACH_INSERT)}, not its parity form nothing`,
    ])
    expect(localBundleErrors(localBundle, `${bundle}\n- id: web-search-deepseek\n  config: {}\n`)).toEqual([
      `${LOCAL_BUNDLE_PATCH_PATH}: @delorun/bundle-local writes row "web-search-deepseek", which LOCAL_ROWS does not list`,
    ])
  })
})

describe('the switch sweep', () => {
  const entry = registryOver(['delorun/packages/plugin-fixture/src/index.ts'])[0] as BuiltParitySwitch
  const listing = (dirs: Record<string, string[]>) => ({ list: (dir: string) => dirs[dir] })

  it('reports a staged scenario as pending recording, never as passing, and a recorded one as replayed by parity-replay', () => {
    const pending = sweep([entry], listing({ [`${STAGED_ROOT}/session/delorun-fixture-context`]: ['runtime.cordis.yml', 'snapshot.yml'], [STAGED_ROOT]: ['session'], [`${STAGED_ROOT}/session`]: ['delorun-fixture-context'] }))
    expect(pending.errors).toEqual([])
    expect(pending.rows.map(sweepLine)).toEqual([`fixture_context: pending recording (${STAGED_ROOT}/session/delorun-fixture-context)`])
    const recorded = sweep([entry], listing({ 'snapshots/session/delorun-fixture-context': ['runtime.cordis.yml', 'session.v4.jsonl', 'snapshot.yml'] }))
    expect(recorded).toEqual({ rows: [{ id: 'fixture_context', state: { kind: 'recorded', scenario: 'session/delorun-fixture-context' } }], errors: [] })
  })

  it('fails a model-visible switch with no scenario, a staged one without its layer, and a staged directory no switch names', () => {
    expect(sweep([entry], listing({})).errors).toEqual([`fixture_context: no switch-on scenario at snapshots/session/delorun-fixture-context and no staged configuration at ${STAGED_ROOT}/session/delorun-fixture-context`])
    expect(sweep([entry], listing({ [`${STAGED_ROOT}/session/delorun-fixture-context`]: ['snapshot.yml'] })).errors).toEqual([`fixture_context: ${STAGED_ROOT}/session/delorun-fixture-context has no runtime.cordis.yml`])
    expect(sweep([], listing({ [STAGED_ROOT]: ['session'], [`${STAGED_ROOT}/session`]: ['delorun-stray'] })).errors).toEqual([`${STAGED_ROOT}/session/delorun-stray is the scenario of no built, model-visible switch`])
  })
})
