/**
 * The runner: one plugin through stages 1-10 on one host, in containers, and a valid card at the end. It starts the
 * run's container hardened (and checks it over `docker inspect`), sets the host up with the mock model, runs each stage
 * in order, calls the observers around each, and writes `card.json`, `card.md`, `shots/` and `logs/` to the run folder.
 * Third-party code only ever runs inside the container.
 *
 * @module @delorun/tools/compat-bench/runner
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { startBox, type Box } from './box.ts'
import { CARD_SCHEMA, deriveVerdict, renderCard, validateCard, type Card, type StageResult } from './card.ts'
import { type Baseline, harness, readRegions, sampleCost, startStudio, type PluginSource, type RunState } from './stages.ts'
import { DEFAULT_STAGES, unmetNeed, type Stage } from './pipeline.ts'
import { COST_RUNS, type CostSample } from './cost.ts'
import { docker } from './docker.ts'
import { imageTag, planImage, PREVIOUS_RELEASE_TAG, resolveCommit } from './images.ts'
import type { ContainerAdditions, Observer, RunContext } from './observer.ts'
import { imageExists } from './update.ts'

/** What a run needs. */
export interface RunRequest {
  /** The repository the candidate commit and the exercises come from. */
  readonly repository: string
  /** The host. */
  readonly host: 'delorun' | 'stock'
  /** The plugin. */
  readonly source: PluginSource
  /** The folder the runs go under. */
  readonly outRoot: string
  /** The observers to call. */
  readonly observers: readonly Observer[]
  /** An exercise file; the package's own in `exercises/` when absent. */
  readonly exercise?: string
  /** A file of `NAME=value` lines passed to the studio process only; never logged. */
  readonly secretEnvFile?: string
  /** Appends a line to the run's log output. */
  readonly log: (line: string) => void
  /** The commit to take the candidate image from; `HEAD` by default. */
  readonly commit?: string
  /** The stages to run, in order; the plan's ten by default. */
  readonly stages?: readonly Stage[]
}

/** What a run made. */
export interface RunResult {
  /** The card. */
  readonly card: Card
  /** The run folder. */
  readonly dir: string
}

/**
 * The package name a spec names.
 * @param source - the plugin source.
 * @returns the name; for a folder, its manifest's name.
 */
export function packageNameOf(source: PluginSource): string {
  if (source.kind === 'folder') return (JSON.parse(readFileSync(join(source.spec, 'package.json'), 'utf8')) as { name: string }).name
  if (source.kind === 'git') return source.spec.replace(/^git\+/, '').replace(/[#?].*$/, '').replace(/\.git$/, '').split('/').pop() ?? source.spec
  const at = source.spec.lastIndexOf('@')
  return at > 0 ? source.spec.slice(0, at) : source.spec
}

/**
 * A folder name for a package.
 * @param name - the package name.
 * @returns the name with `/` made `__`.
 */
export function folderName(name: string): string {
  return name.replace(/^@/, '').replace(/\//g, '__')
}

/**
 * Where the exercise for a package lives.
 * @param name - the package name.
 * @returns the path under `compat-bench/exercises/`.
 */
export function exercisePath(name: string): string {
  return join(dirname(new URL(import.meta.url).pathname), 'exercises', `${folderName(name)}.js`)
}

/**
 * The registry's record of a package, when the source is npm: version, integrity, repository, licence and engines.
 * It asks the public registry for metadata only; nothing of the plugin runs on the host.
 * @param spec - the npm spec.
 * @returns what is known.
 */
function registryRecord(spec: string): Partial<Card['plugin']> {
  try {
    const text = execFileSync('npm', ['view', spec, '--json', 'version', 'dist.integrity', 'repository', 'license', 'engines'], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] })
    const record = JSON.parse(text) as { version?: string, 'dist.integrity'?: string, repository?: { url?: string } | string, license?: string, engines?: { delorun?: string, dsh?: string } }
    const repository = typeof record.repository === 'string' ? record.repository : record.repository?.url
    return {
      ...(record.version === undefined ? {} : { version: record.version }),
      ...(record['dist.integrity'] === undefined ? {} : { integrity: record['dist.integrity'] }),
      ...(repository === undefined ? {} : { repository }),
      ...(record.license === undefined ? {} : { licence: record.license }),
      ...(record.engines === undefined ? {} : { engines: { ...(record.engines.delorun === undefined ? {} : { delorun: record.engines.delorun }), ...(record.engines.dsh === undefined ? {} : { dsh: record.engines.dsh }) } }),
    }
  } catch {
    // The registry may be unreachable or not know the spec; the card then carries what the installed manifest says.
    return {}
  }
}

/**
 * The plugin facts the card keeps, from the installed manifest where the registry did not say.
 * @param box - the container.
 * @param name - the package name.
 * @returns what the manifest holds.
 */
async function installedRecord(box: Box, name: string): Promise<Partial<Card['plugin']>> {
  const read = await box.exec(['cat', `/home/bench/home/delorun/profiles/default/node_modules/${name}/package.json`])
  if (read.code !== 0) return {}
  const manifest = JSON.parse(read.stdout) as { version?: string, license?: string, repository?: { url?: string } | string, engines?: { delorun?: string, dsh?: string } }
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  return {
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    ...(manifest.license === undefined ? {} : { licence: manifest.license }),
    ...(repository === undefined ? {} : { repository }),
    ...(manifest.engines === undefined ? {} : { engines: { ...(manifest.engines.delorun === undefined ? {} : { delorun: manifest.engines.delorun }), ...(manifest.engines.dsh === undefined ? {} : { dsh: manifest.engines.dsh }) } }),
  }
}

/**
 * The tag of the image a host runs on.
 * @param request - the run.
 * @returns the tag.
 */
function hostImage(request: { readonly repository: string, readonly host: 'delorun' | 'stock', readonly commit?: string }): string {
  return planImage({ repository: request.repository, host: request.host, ...(request.commit === undefined ? {} : { commit: request.commit }) }).tag
}

/**
 * The folder baselines are kept in.
 * @param outRoot - the folder runs go under.
 * @returns the folder.
 */
function baselineDir(outRoot: string): string {
  return join(dirname(outRoot), 'baselines')
}

/**
 * Start a container for a run and set the host up.
 * @param image - the image.
 * @param name - the container's name.
 * @param runId - the run's id.
 * @param outDir - the run folder.
 * @param ctx - the run's facts, for the observers.
 * @param observers - the observers.
 * @param host - `delorun` or `stock`.
 * @returns the box.
 */
async function startRunBox(image: string, name: string, runId: string, outDir: string, ctx: RunContext, observers: readonly Observer[], host: 'delorun' | 'stock', secretEnvFile?: string): Promise<{ readonly box: Box, readonly additions: readonly ContainerAdditions[] }> {
  const additions: ContainerAdditions[] = await Promise.all(observers.map(async observer => await observer.prepare(ctx)))
  if (secretEnvFile !== undefined) additions.push({ files: [{ path: '/home/bench/.bench-secrets.env', content: readFileSync(secretEnvFile, 'utf8'), mode: 0o400 }] })
  const box = await startBox({ name, image, runId, outDir, user: `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`, env: { BENCH_HOST: host, BENCH_RUN_ID: runId } }, additions)
  const setup = await box.script('ctl', ['setup'], { timeoutMs: 600_000 })
  if (!setup.ok) throw new Error(`setting the host up failed: ${String(setup.output ?? '')}`)
  const mock = await box.script('ctl', ['mock-start'], { timeoutMs: 60_000 })
  if (!mock.ok) throw new Error('the mock model did not start')
  return { box, additions }
}

/**
 * The state of a run with nothing done yet.
 * @param box - the container.
 * @param host - the host.
 * @param source - the plugin.
 * @param exercise - the exercise file, if any.
 * @param log - the run's log.
 * @param run - the run's id, folder and image.
 * @returns the state.
 */
function freshState(box: Box, host: 'delorun' | 'stock', source: PluginSource, exercise: string | undefined, log: (line: string) => void, run: { readonly runId: string, readonly outDir: string, readonly image: string, readonly testChatMarker?: string }): RunState {
  return { box, host, source, packageName: packageNameOf(source), installSpec: source.spec, installed: false, started: false, pluginOn: true, pluginLabel: undefined, exercise, baseline: undefined, homeBefore: [], notes: [], log, runId: run.runId, outDir: run.outDir, image: run.image, prevImage: imageTag('delorun-prev', PREVIOUS_RELEASE_TAG), testChatMarker: run.testChatMarker }
}

/** A baseline and where it was written. */
export interface BaselineResult {
  /** The baseline. */
  readonly baseline: Baseline
  /** The file. */
  readonly path: string
}

/**
 * Make or read the baseline of an image: with no plugin, the studio starts, one chat is sent, then the regions and three
 * cost samples are read. Observers see the same activity as in a plugin run, with `baseline: true`; a cached baseline
 * is used only when it was made with every observer asked for.
 * @param request - the host, repository, folders and observers.
 * @returns the baseline.
 */
export async function runBaseline(request: { readonly repository: string, readonly host: 'delorun' | 'stock', readonly outRoot: string, readonly log: (line: string) => void, readonly commit?: string, readonly force?: boolean, readonly observers?: readonly Observer[] }): Promise<BaselineResult> {
  const image = hostImage(request)
  const observers = request.observers ?? []
  const path = join(baselineDir(request.outRoot), `${image.replace(/[:/]/g, '_')}.json`)
  if (existsSync(path) && request.force !== true) {
    const cached = JSON.parse(readFileSync(path, 'utf8')) as Baseline
    if (observers.every(observer => cached.observed?.includes(observer.name) === true)) return { baseline: cached, path }
  }
  if (!await imageExists(image)) throw new Error(`the image ${image} is not built; run: image build --host ${request.host}`)
  const runId = `base-${String(Date.now())}-${request.host}`
  const outDir = join(request.outRoot, '_baseline', `${new Date().toISOString().replace(/[:.]/g, '-')}-${request.host}`)
  mkdirSync(outDir, { recursive: true, mode: 0o777 })
  const ctx: RunContext = { host: request.host, package: '(none)', outDir, runId, baseline: true, studioPort: 18590, container: `bench-${runId}` }
  const { box, additions } = await startRunBox(image, `bench-${runId}`, runId, outDir, ctx, observers, request.host)
  try {
    const marker = additions.map(add => add.testChatMarker).find(each => each !== undefined)
    const state = freshState(box, request.host, { kind: 'npm', spec: '(none)' }, undefined, request.log, { runId, outDir, image, ...(marker === undefined ? {} : { testChatMarker: marker }) })
    for (const stage of [{ name: 'start' as const, run: async () => { await startStudio(state) } }, { name: 'harness' as const, run: async () => { await harness(state) } }]) {
      for (const observer of observers) await observer.mark(stage.name, 'before', ctx)
      await stage.run()
      for (const observer of observers) await observer.mark(stage.name, 'after', ctx)
    }
    const regions = await readRegions(state)
    const samples: CostSample[] = []
    for (let run = 0; run < COST_RUNS; run++) samples.push(await sampleCost(state))
    for (const observer of observers) await observer.finish(ctx)
    const baseline: Baseline = { regions, samples, observed: observers.map(observer => observer.name) }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`)
    return { baseline, path }
  } finally {
    await box.remove()
  }
}

/**
 * Run one plugin on one host.
 * @param request - the run.
 * @returns the card and its folder.
 */
export async function runBench(request: RunRequest): Promise<RunResult> {
  const name = packageNameOf(request.source)
  const startedAt = new Date()
  const runId = `${startedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${request.host}-${Math.random().toString(36).slice(2, 6)}`
  const dir = join(request.outRoot, folderName(name), `${startedAt.toISOString().replace(/[:.]/g, '-')}-${request.host}`)
  mkdirSync(join(dir, 'shots'), { recursive: true, mode: 0o777 })
  mkdirSync(join(dir, 'logs'), { recursive: true, mode: 0o777 })
  const log = (line: string): void => { request.log(line); writeFileSync(join(dir, 'logs', 'bench.log'), `${line}\n`, { flag: 'a' }) }
  const image = hostImage(request)
  if (!await imageExists(image)) throw new Error(`the image ${image} is not built; run: image build --host ${request.host}`)
  const ctx: RunContext = { host: request.host, package: name, outDir: dir, runId, baseline: false, studioPort: 18590, container: `bench-${runId}` }
  const stages: StageResult[] = []
  const notes: string[] = []
  const { baseline } = await runBaseline({ repository: request.repository, host: request.host, outRoot: request.outRoot, log, observers: request.observers, ...(request.commit === undefined ? {} : { commit: request.commit }) })
  const { box, additions } = await startRunBox(image, `bench-${runId}`, runId, dir, ctx, request.observers, request.host, request.secretEnvFile)
  try {
    const marker = additions.map(add => add.testChatMarker).find(each => each !== undefined)
    const state = freshState(box, request.host, request.source, request.exercise ?? (existsSync(exercisePath(name)) ? exercisePath(name) : undefined), log, { runId, outDir: dir, image, ...(marker === undefined ? {} : { testChatMarker: marker }) })
    state.baseline = baseline
    const hostInfo = await box.script('ctl', ['version'])
    const hostVersion = String(hostInfo.version ?? 'unknown')
    notes.push(`the host reported ${String(hostInfo.own ?? hostVersion)}${typeof hostInfo.dsh === 'string' ? `, built on DSH ${hostInfo.dsh}` : ''}`)
    for (const stage of request.stages ?? DEFAULT_STAGES) {
      const unmet = unmetNeed(stage, state)
      if (unmet !== undefined) {
        stages.push({ name: stage.name, status: 'skipped', reason: unmet, durationMs: 0, failures: [] })
        continue
      }
      for (const observer of request.observers) await observer.mark(stage.name, 'before', ctx)
      log(`stage ${stage.name}`)
      const result = await stage.run(state)
      stages.push(result)
      for (const observer of request.observers) await observer.mark(stage.name, 'after', ctx)
      log(`stage ${stage.name}: ${result.status}`)
    }
    const record = { ...(request.source.kind === 'npm' ? registryRecord(request.source.spec) : {}), ...await installedRecord(box, name) }
    const manifestText = await box.exec(['cat', `/home/bench/home/delorun/profiles/default/node_modules/${name}/package.json`])
    if (manifestText.code === 0) writeFileSync(join(dir, 'plugin-package.json'), manifestText.stdout)
    let privacy: Card['privacy']
    let declared: Card['declared'] = manifestText.code === 0 ? (JSON.parse(manifestText.stdout) as { dsh?: { access?: Record<string, unknown> } }).dsh?.access : undefined
    for (const observer of request.observers) {
      const section = await observer.finish(ctx)
      if (section !== undefined && privacy === undefined) {
        privacy = { markers: Object.fromEntries(Object.entries(section.markers).map(([key, marker]) => [key, { state: marker.state, summary: marker.summary, evidence: [...marker.evidence] }])) as NonNullable<Card['privacy']>['markers'], contentsChecked: section.contentsChecked, ...(section.findings === undefined ? {} : { findings: [...section.findings] }) }
        if (section.declared !== undefined) declared = { ...declared, ...section.declared }
      }
    }
    notes.push(...state.notes)
    const card: Card = {
      schema: CARD_SCHEMA, runId, startedAt: startedAt.toISOString(),
      plugin: { package: name, ...record },
      host: { kind: request.host, version: hostVersion, ...(request.host === 'delorun' ? { commit: resolveCommit(request.repository, request.commit ?? 'HEAD').slice(0, 12) } : {}), shims: false },
      stages, ...(privacy === undefined ? {} : { privacy }), ...(declared === undefined ? {} : { declared }),
      verdict: deriveVerdict(stages), notes,
    }
    const valid = validateCard(card)
    if (!valid.ok) throw new Error(`the run made an invalid card: ${valid.problems.join('; ')}`)
    writeFileSync(join(dir, 'card.json'), `${JSON.stringify(card, null, 2)}\n`)
    writeFileSync(join(dir, 'card.md'), renderCard(card))
    return { card, dir }
  } finally {
    await box.remove()
    await docker(['volume', 'prune', '-f', '--filter', 'label=delorun.bench=1'])
  }
}
