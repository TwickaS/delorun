/**
 * The privacy observer (A587): plants the canaries, starts the network helper, and after the run turns the hooks' log,
 * the helper's report, `docker diff`, the canary search after uninstall and the mock model's requests into the eight
 * privacy markers, with a no-plugin baseline subtracted.
 *
 * @module @delorun/tools/compat-bench/privacy/observer
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Observer, PrivacySection, StageName } from '../observer.ts'
import { readDeclaredAccess } from './access.ts'
import { defaultBaselineDir, loadBaseline, saveBaseline } from './baseline.ts'
import { DEFAULT_LAYOUT, MODEL_KEY_ENV, makeCanaries, watchList } from './canaries.ts'
import type { Canaries, CanaryLayout } from './canaries.ts'
import { realDocker } from './docker.ts'
import type { Docker } from './docker.ts'
import { parseEvents, summarise } from './events.ts'
import { buildHelperImage, collectHelper, removeStaleHelpers, startHelper, stopHelper } from './helper/image.ts'
import { buildPrivacy } from './markers.ts'
import { assemble } from './observed.ts'
import type { RunFacts } from './observed.ts'
import { signatureOf } from './requests.ts'
import type { HelperReport, NetEvent, PrivacyAdditions, PrivacyReport, PrivacyRunContext, ProxyHost } from './types.ts'

/**
 * Where the preload and the CA go in the plugin container, and where the output folder is mounted (agreed with bench-core).
 * @param layout - where the user's home is in the container.
 * @returns the three paths.
 */
export function containerPaths(layout: CanaryLayout): Readonly<{ preload: string; ca: string; outDir: string }> {
  return { preload: `${layout.userHome}/.bench-privacy/privacy-preload.mjs`, ca: `${layout.userHome}/.bench-privacy/ca.pem`, outDir: '/out' }
}

/**
 * @param run - the run's context.
 * @returns the plugin container's name: the runner's `bench-<runId>` unless the context names another.
 */
function containerOf(run: PrivacyRunContext): string {
  return run.container ?? `bench-${run.runId}`
}

/** How to make an observer. */
export type PrivacyObserverOptions = Readonly<{
  docker?: Docker
  layout?: CanaryLayout
  /** Where baselines are kept; default `~/.cache/delorun/compat-bench`. */
  baselineDir?: string
  /** Proxy arguments for the helper's own tests. */
  proxyArgs?: string
  /** The clock, for tests. */
  now?: () => Date
}>

/** What the observer keeps for one run between its calls. */
type RunState = {
  canaries: Canaries
  helper: string
  snapshot?: { fileChanges: RunFacts['fileChanges']; leftCanaries: RunFacts['leftCanaries'] }
}

/** Paths under which `docker diff` changes are never searched or reported. */
const SKIP_SEARCH = ['/proc', '/sys', '/dev', '/out']

/**
 * Parse `docker diff`'s output.
 * @param text - the output, lines such as `A /home/bench/x`.
 * @returns the changes.
 */
export function parseDiff(text: string): RunFacts['fileChanges'] {
  const changes: { kind: 'A' | 'C' | 'D'; path: string }[] = []
  for (const line of text.split('\n')) {
    const match = /^([ACD]) (\/.*)$/.exec(line.trim())
    if (match?.[1] !== undefined && match[2] !== undefined) changes.push({ kind: match[1] as 'A' | 'C' | 'D', path: match[2] })
  }
  return changes
}

/**
 * Read what the helper wrote.
 * @param folder - the folder the helper's `/out` was copied to.
 * @returns the report; empty lists when a file is missing.
 */
export async function readHelperReport(folder: string): Promise<HelperReport> {
  let hosts: ProxyHost[] = []
  try {
    const parsed: unknown = JSON.parse(await readFile(join(folder, 'hosts.json'), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'hosts' in parsed && Array.isArray(parsed.hosts)) hosts = parsed.hosts as ProxyHost[]
  } catch { /* no proxy report */ }
  const net: NetEvent[] = []
  try {
    for (const line of (await readFile(join(folder, 'net.jsonl'), 'utf8')).split('\n')) {
      if (line.trim() === '') continue
      try { net.push(JSON.parse(line) as NetEvent) } catch { /* a torn line */ }
    }
  } catch { /* no net log */ }
  return { hosts, net }
}

/**
 * Make the privacy observer.
 * @param options - the docker function, the layout, the baseline folder and so on.
 * @returns the observer.
 */
export function createPrivacyObserver(options: PrivacyObserverOptions = {}): Observer {
  const docker = options.docker ?? realDocker
  const layout = options.layout ?? DEFAULT_LAYOUT
  const baselineDir = options.baselineDir ?? defaultBaselineDir()
  const now = options.now ?? (() => new Date())
  const states = new Map<string, RunState>()
  const paths = containerPaths(layout)

  /** Take the after-uninstall snapshot: `docker diff`, and a search of the changed paths for each canary. */
  async function takeSnapshot(state: RunState, container: string): Promise<NonNullable<RunState['snapshot']>> {
    const diff = await docker(['diff', container])
    const fileChanges = parseDiff(diff.stdout).filter(change => !SKIP_SEARCH.some(prefix => change.path === prefix || change.path.startsWith(`${prefix}/`)))
    const planted = new Set(state.canaries.files.map(file => file.path))
    const candidates = fileChanges.filter(change => change.kind !== 'D' && !planted.has(change.path)).map(change => change.path)
    const leftCanaries: { canary: string; path: string }[] = []
    for (const [canary, value] of Object.entries(state.canaries.values)) {
      for (let index = 0; index < candidates.length; index += 150) {
        const batch = candidates.slice(index, index + 150)
        const found = await docker(['exec', container, 'grep', '-rlIF', '-e', value, '--', ...batch])
        for (const path of found.stdout.split('\n')) if (path !== '' && !planted.has(path)) leftCanaries.push({ canary, path })
      }
    }
    return { fileChanges, leftCanaries }
  }

  return {
    name: 'privacy',

    async prepare(ctx) {
      const run = ctx as PrivacyRunContext
      if (!run.baseline && await loadBaseline(baselineDir, run.host) === undefined) throw new Error(`no privacy baseline for ${run.host}: run \`bench baseline --host ${run.host}\` first`)
      const canaries = makeCanaries(run.runId, layout)
      await removeStaleHelpers(docker)
      const image = await buildHelperImage(docker)
      // Nothing is published unless the runner asks: the studio and the browser both run inside the plugin container.
      const publish = run.publish
      const folder = join(run.outDir, 'privacy')
      await mkdir(folder, { recursive: true })
      // The plugin container runs as the same user and writes the hooks' log here through the mounted output folder.
      const helper = await startHelper(docker, image, { runId: run.runId, outDir: run.outDir, canaries: canaries.values, ...publish === undefined ? {} : { publish }, ...options.proxyArgs === undefined ? {} : { proxyArgs: options.proxyArgs } })
      states.set(run.runId, { canaries, helper: helper.name })
      const preload = await readFile(new URL('./preload.mjs', import.meta.url), 'utf8')
      const ca = await readFile(helper.caPath, 'utf8')
      const additions: PrivacyAdditions = {
        env: {
          DELORUN_PRIVACY_LOG: `${paths.outDir}/privacy/events.jsonl`,
          DELORUN_PRIVACY_WATCH: JSON.stringify(watchList(canaries, layout)),
          NODE_EXTRA_CA_CERTS: paths.ca,
          [MODEL_KEY_ENV]: canaries.modelKey,
        },
        files: [
          { path: paths.preload, content: preload, mode: 0o644 },
          { path: paths.ca, content: ca, mode: 0o644 },
          ...canaries.files.map(file => ({ path: file.path, content: file.content, mode: file.mode })),
        ],
        networkContainer: helper.name,
        pidContainer: helper.name,
        caCertPath: paths.ca,
        preloads: [paths.preload],
        testChatMarker: canaries.chatWord,
      }
      return additions
    },

    async mark(stage: StageName, phase, ctx) {
      const run = ctx as PrivacyRunContext
      const folder = join(run.outDir, 'privacy')
      await mkdir(folder, { recursive: true })
      await appendFile(join(folder, 'stages.jsonl'), `${JSON.stringify({ at: now().toISOString(), stage, phase })}\n`)
      const state = states.get(run.runId)
      if (state !== undefined && stage === 'uninstall' && phase === 'after') state.snapshot = await takeSnapshot(state, containerOf(run))
    },

    async finish(ctx): Promise<PrivacySection | undefined> {
      const run = ctx as PrivacyRunContext
      const state = states.get(run.runId)
      if (state === undefined) return undefined
      const folder = join(run.outDir, 'privacy')
      if (state.snapshot === undefined) state.snapshot = await takeSnapshot(state, containerOf(run))
      const helperFolder = await collectHelper(docker, state.helper, run.outDir).catch(() => undefined)
      await stopHelper(docker, state.helper)
      states.delete(run.runId)
      const events = parseEvents(await readFile(join(folder, 'events.jsonl'), 'utf8').catch(() => ''))
      const requests = await readFile(join(run.outDir, 'logs', 'mock-requests.jsonl'), 'utf8').catch(() => '')
      const request = signatureOf(requests, state.canaries.chatWord)
      const facts: RunFacts = {
        hooks: summarise(events),
        ...helperFolder === undefined ? {} : { helper: await readHelperReport(helperFolder) },
        fileChanges: state.snapshot?.fileChanges ?? [],
        leftCanaries: state.snapshot?.leftCanaries ?? [],
        ...request === undefined ? {} : { request },
      }
      if (run.baseline) {
        await saveBaseline(baselineDir, run.host, facts, now().toISOString())
        return undefined
      }
      const baseline = await loadBaseline(baselineDir, run.host)
      const manifest: unknown = await readFile(join(run.outDir, 'plugin-package.json'), 'utf8').then((text): unknown => JSON.parse(text)).catch(() => undefined)
      const access = readDeclaredAccess(manifest)
      const report: PrivacyReport = buildPrivacy(assemble(facts, baseline), access.declared, layout)
      // The card takes the markers, the findings and the declared reasons; problems with the block stay beside it.
      await writeFile(join(folder, 'report.json'), `${JSON.stringify({ ...report, problems: access.problems.map(problem => `dsh.access: ${problem}`) }, null, 2)}\n`)
      return report
    },
  }
}
