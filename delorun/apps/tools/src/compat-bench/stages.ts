/**
 * The stages of one run on one host, each a function from the run's state to a {@link StageResult}. Stages 1-6, 8, 9 and
 * 10 run in the run's container through the container-side scripts; stage 7 (update) starts two more containers from the
 * previous release's image and the candidate's, joined by a run-scoped Docker volume that holds the home.
 *
 * @module @delorun/tools/compat-bench/stages
 */
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Box } from './box.ts'
import type { StageResult } from './card.ts'
import { compareRegions, type RegionSignature } from './clashes.ts'
import { classifyFailure, findPluginLocation } from './classify.ts'
import { COST_RUNS, costFindings, type CostSample } from './cost.ts'
import type { StageName } from './observer.ts'

/** What the plugin is and where it comes from. */
export interface PluginSource {
  /** `npm`: a registry package; `folder`: a folder on the host (fixtures); `git`: a git address. */
  readonly kind: 'npm' | 'folder' | 'git'
  /** The spec the user gave. */
  readonly spec: string
}

/** What a run on one host has learned so far. */
export interface RunState {
  /** The run's container. */
  readonly box: Box
  /** `delorun` or `stock`. */
  readonly host: 'delorun' | 'stock'
  /** The plugin's source. */
  readonly source: PluginSource
  /** The package name once known. */
  packageName: string
  /** The spec handed to `plugin add`. */
  installSpec: string
  /** Whether the plugin is installed. */
  installed: boolean
  /** Whether the studio started with the plugin. */
  started: boolean
  /** Whether the plugin is still on; the studio's switch turned it off when it refused to turn it back on. */
  pluginOn: boolean
  /** The plugin's own Settings label, learned from its manifest, for the clash check. */
  pluginLabel: string | undefined
  /** The exercise file on the host, if any. */
  readonly exercise: string | undefined
  /** The no-plugin baseline for this image. */
  baseline: Baseline | undefined
  /** The home's files before the install, for the leftovers check. */
  homeBefore: readonly string[]
  /** Facts the card keeps. */
  readonly notes: string[]
  /** Appends a line to the run's log. */
  readonly log: (line: string) => void
  /** The run's id. */
  readonly runId: string
  /** The run's output folder on the host. */
  readonly outDir: string
  /** The tag of the image this run uses. */
  readonly image: string
  /** The tag of the previous release's image, for the update stage. */
  readonly prevImage: string
  /** The word the privacy observer asked to be in the test chat message, if any. */
  readonly testChatMarker: string | undefined
}

/** The baseline of an image: the regions and the three cost runs without a plugin. */
export interface Baseline {
  /** The regions without the plugin. */
  readonly regions: RegionSignature
  /** Three cost samples without the plugin. */
  readonly samples: readonly CostSample[]
  /** The observers that ran while the baseline was made. */
  readonly observed?: readonly string[]
}

/** The viewport widths of the screens stage. */
export const VIEWPORTS = [1440, 390] as const

/** Log text that means the studio did not start or stopped (fresh-home-smoke's list). */
const START_FAILURES: readonly RegExp[] = [/failed to start/i, /failed to import/i, /\bstopped\b/i, /ValidationError/, /Cannot find (module|package)/, /ERR_MODULE_NOT_FOUND/]

/**
 * Time a stage body.
 * @param name - the stage.
 * @param body - the work; returns what the result needs besides its duration.
 * @returns the result, a thrown error becoming a failure of the stage.
 */
export async function timed(name: StageName, body: () => Promise<Omit<StageResult, 'name' | 'durationMs'>>): Promise<StageResult> {
  const began = Date.now()
  try {
    // The body runs first: reading the clock in the object literal would measure only the wait before the work.
    const result = await body()
    return { ...result, name, durationMs: Date.now() - began }
  } catch (error) {
    return { name, durationMs: Date.now() - began, status: 'fail', failures: [classifyFailure(name, [error instanceof Error ? error.message : String(error)])] }
  }
}

/**
 * Read the lines of the studio's logs that report a start-up failure or an error.
 * @param box - the container.
 * @returns the lines.
 */
export async function studioErrors(box: Box): Promise<string[]> {
  const logs = await box.exec(['sh', '-c', 'cat /out/logs/studio-*.log 2>/dev/null | tail -n 400'])
  return logs.stdout.split('\n').filter(line => START_FAILURES.some(pattern => pattern.test(line)) || /\b(error|ERR)\b/.test(line) && /plugin|load|import/i.test(line))
}

/**
 * Stage 1: install.
 * @param state - the run.
 * @returns the result.
 */
export async function install(state: RunState): Promise<StageResult> {
  return await timed('install', async () => {
    const tree = await state.box.script('ctl', ['tree'])
    state.homeBefore = (tree.files as string[] | undefined) ?? []
    if (state.source.kind === 'folder') {
      await state.box.exec(['mkdir', '-p', '/home/bench/plugin-src'])
      await state.box.copyIn(state.source.spec, '/home/bench/plugin-src/')
      state.installSpec = `/home/bench/plugin-src/${state.source.spec.split('/').filter(each => each !== '').pop() ?? ''}`
    }
    const added = await state.box.script('ctl', ['plugin-add', state.installSpec], { timeoutMs: 900_000 })
    const output = String(added.output ?? '')
    if (added.ok !== true) {
      const lines = output.split('\n').map(line => line.trim()).filter(line => line !== '')
      return { status: 'fail', failures: [classifyFailure('install', lines.filter(line => /reject|refus|error|ERR|fail|engines/i.test(line)).concat(lines.slice(-5)))] }
    }
    const manifest = await state.box.exec(['cat', `/home/bench/home/delorun/profiles/default/node_modules/${state.packageName}/package.json`])
    state.installed = true
    const risks = output.split('\n').filter(line => /risk|warn/i.test(line)).map(line => line.trim()).slice(0, 10)
    const locale = await state.box.exec(['cat', `/home/bench/home/delorun/profiles/default/node_modules/${state.packageName}/locale/en.json`])
    if (locale.code === 0) state.pluginLabel = (JSON.parse(locale.stdout) as { meta?: { title?: string } }).meta?.title
    if (manifest.code === 0) state.notes.push(`installed manifest read (${String(manifest.stdout.length)} bytes)`)
    return { status: 'pass', failures: [], ...(risks.length > 0 ? { facts: { 'install check lines': risks.length } } : {}) }
  })
}

/**
 * Start the studio and check its log; the part of stage 2 that restarts reuse.
 * @param state - the run.
 * @returns the start time in milliseconds, and the errors found; `ok` is false when the studio did not listen.
 */
export async function startStudio(state: RunState): Promise<{ readonly ok: boolean, readonly startMs: number, readonly errors: string[] }> {
  const started = await state.box.script('ctl', ['studio-start'], { timeoutMs: 300_000 })
  const errors = await studioErrors(state.box)
  return { ok: started.ok && errors.every(line => !START_FAILURES.some(pattern => pattern.test(line))), startMs: Number(started.startMs ?? 0), errors }
}

/**
 * The lines of a host report a card keeps: its summary of counts, then each line that reports a problem.
 * @param label - the command whose output this is.
 * @param output - its text.
 * @returns the notes, one line each.
 */
export function hostNotes(label: string, output: string): string[] {
  const lines = output.split('\n').map(line => line.trim()).filter(line => line !== '')
  const summary = lines.find(line => /^\d+ passed/.test(line))
  const problems = lines.filter(line => /^[!✗×]/.test(line) || /^failed\s/.test(line))
  return [...(summary === undefined ? [] : [`${label}: ${summary}`]), ...problems.slice(0, 12).map(line => `${label}: ${line}`)]
}

/**
 * Stage 2: start, then `delorun doctor` and `verify`.
 * @param state - the run.
 * @returns the result.
 */
export async function start(state: RunState): Promise<StageResult> {
  return await timed('start', async () => {
    const started = await startStudio(state)
    state.started = started.ok
    if (!started.ok) {
      const log = (await state.box.exec(['sh', '-c', 'tail -n 60 /out/logs/studio-*.log 2>/dev/null'])).stdout
      return { status: 'fail', failures: [classifyFailure('start', [...started.errors, ...log.split('\n').slice(-10)], findPluginLocation(log))] }
    }
    const doctor = await state.box.script('ctl', ['doctor'], { timeoutMs: 240_000 })
    const facts: Record<string, string | number | boolean> = { startMs: started.startMs }
    if (typeof doctor.skipped === 'string') facts.doctor = `skipped: ${doctor.skipped}`
    else {
      facts.doctor = Number(doctor.doctor) === 0 ? 'ok' : `exit ${String(doctor.doctor)}`
      facts.verify = Number(doctor.verify) === 0 ? 'ok' : `exit ${String(doctor.verify)}`
      // The card carries what the host said about itself, not only the exit codes: the issue asks for the doctor output.
      state.notes.push(...hostNotes('delorun doctor', String(doctor.doctorOutput ?? '')))
      state.notes.push(...hostNotes('delorun verify', String(doctor.verifyOutput ?? '')))
    }
    return { status: 'pass', failures: [], facts }
  })
}

/**
 * The link the browser signs in with.
 * @param state - the run.
 * @returns the link.
 * @throws Error when the host printed none.
 */
export async function signInLink(state: RunState): Promise<string> {
  const answer = await state.box.script('ctl', ['link'], { timeoutMs: 90_000 })
  if (answer.ok !== true || typeof answer.link !== 'string') throw new Error('the host printed no sign-in link')
  return answer.link
}

/**
 * Run one browser task.
 * @param state - the run.
 * @param task - the task name.
 * @param args - its flags.
 * @returns the script's answer.
 */
export async function browse(state: RunState, task: string, args: readonly string[] = []): Promise<Record<string, unknown> & { readonly ok: boolean }> {
  const link = await signInLink(state)
  return await state.box.script('browse', [task, '--link', link, ...args], { timeoutMs: 300_000 })
}

/**
 * Stage 3: the harness still answers a chat message.
 * @param state - the run.
 * @returns the result.
 */
export async function harness(state: RunState): Promise<StageResult> {
  return await timed('harness', async () => {
    const answer = await browse(state, 'chat', state.testChatMarker === undefined ? [] : ['--marker', state.testChatMarker])
    if (!answer.ok) return { status: 'fail', failures: [classifyFailure('harness', [String(answer.error ?? 'no reply'), ...((answer.consoleErrors as string[] | undefined) ?? [])])] }
    return { status: 'pass', failures: [], facts: { 'reply seen': true } }
  })
}

/**
 * Stage 4: screens at 1440 and 390 px, and the browser console.
 * @param state - the run.
 * @returns the result.
 */
export async function screens(state: RunState): Promise<StageResult> {
  return await timed('screens', async () => {
    const answer = await browse(state, 'screens', ['--widths', VIEWPORTS.join(','), ...(state.pluginLabel === undefined ? [] : ['--label', state.pluginLabel])])
    const errors = (answer.consoleErrors as string[] | undefined) ?? []
    const shots = (answer.shots as string[] | undefined) ?? []
    if (!answer.ok || errors.length > 0) return { status: 'fail', failures: [classifyFailure('screens', errors.length > 0 ? errors : [String(answer.error ?? 'a screen did not draw')])], shots }
    return { status: 'pass', failures: [], shots, facts: { 'console errors': 0 } }
  })
}

/**
 * Stage 5: the feature check, from `exercises/<package>.js` or `--exercise`.
 * @param state - the run.
 * @param exerciseFile - the exercise on the host, or undefined.
 * @returns the result.
 */
export async function feature(state: RunState, exerciseFile: string | undefined): Promise<StageResult> {
  return await timed('feature', async () => {
    if (exerciseFile === undefined || !existsSync(exerciseFile)) return { status: 'skipped', reason: 'no exercise written for this package yet', failures: [] }
    await state.box.exec(['mkdir', '-p', '/home/bench/exercises'])
    const dir = join(state.box.outDir, 'exercise')
    mkdirSync(dir, { recursive: true })
    await state.box.copyIn(exerciseFile, '/home/bench/exercises/exercise.js')
    const answer = await browse(state, 'exercise', ['--file', '/home/bench/exercises/exercise.js'])
    if (!answer.ok) return { status: 'fail', failures: [classifyFailure('feature', [String(answer.error ?? 'the exercise failed'), ...((answer.consoleErrors as string[] | undefined) ?? [])])], ...(Array.isArray(answer.shots) ? { shots: answer.shots as string[] } : {}) }
    return { status: 'pass', failures: [], ...(Array.isArray(answer.shots) ? { shots: answer.shots as string[] } : {}), facts: { returned: String(answer.returned ?? '').slice(0, 120) } }
  })
}

/**
 * Stage 6: stop and start the studio, the profile's settings kept and the plugin still loaded; then switch the plugin off and on.
 * @param state - the run.
 * @returns the result.
 */
export async function restart(state: RunState): Promise<StageResult> {
  return await timed('restart', async () => {
    const patch = async (): Promise<string> => (await state.box.exec(['sh', '-c', 'cat /home/bench/home/delorun/profiles/default/cordis.patch.yml 2>/dev/null; cat /home/bench/home/delorun/profiles/default/package.json 2>/dev/null'])).stdout
    const before = await patch()
    await state.box.script('ctl', ['studio-stop'], { timeoutMs: 60_000 })
    const started = await startStudio(state)
    if (!started.ok) return { status: 'fail', failures: [classifyFailure('restart', started.errors)] }
    const after = await patch()
    if (after !== before) return { status: 'fail', failures: [classifyFailure('restart', ['the profile configuration changed across a restart'])], facts: { 'config kept': false } }
    const page = await browse(state, 'screens', ['--widths', '1440', '--name', 'restart', ...(state.pluginLabel === undefined ? [] : ['--label', state.pluginLabel])])
    if (!page.ok) return { status: 'fail', failures: [classifyFailure('restart', [String(page.error ?? 'the screens did not draw after the restart')])] }
    if (state.host === 'stock') return { status: 'pass', failures: [], facts: { 'config kept': true, 'off and on': 'not offered for a third-party plugin on stock' } }
    const toggled = await browse(state, 'toggle', ['--package', state.packageName])
    if (toggled.ok !== true) return { status: 'fail', failures: [classifyFailure('restart', [String(toggled.error ?? 'switching the plugin off and on failed')])], facts: { 'config kept': true } }
    if (toggled.restored !== true) {
      // The studio took the switch off and would not put it back: the plugin is not at fault, but it is no longer loaded,
      // so every later stage would measure a home without it.
      state.pluginOn = false
      return {
        status: 'fail',
        failures: [{ signature: 'the studio switched the plugin off and would not switch it back on', evidence: [String(toggled.refusal ?? 'the switch did not return to its first state')], cause: 'studio-switch-refused', fixClass: 'delorun-fix' }],
        facts: { 'config kept': true, 'off and on': 'switched off, not back on' },
      }
    }
    return { status: 'pass', failures: [], facts: { 'config kept': true, 'off and on': 'done without a restart' } }
  })
}

/**
 * Read the studio's regions.
 * @param state - the run.
 * @returns the signature.
 */
export async function readRegions(state: RunState): Promise<RegionSignature> {
  const answer = await browse(state, 'regions')
  if (!answer.ok) throw new Error(String(answer.error ?? 'the regions could not be read'))
  return answer.regions as RegionSignature
}

/**
 * Stage 8: the regions with the plugin against the baseline's.
 * @param state - the run.
 * @returns the result.
 */
export async function clashes(state: RunState): Promise<StageResult> {
  return await timed('clashes', async () => {
    if (!state.pluginOn) return { status: 'skipped', reason: 'the studio switched the plugin off before this stage', failures: [] }
    if (state.baseline === undefined) return { status: 'skipped', reason: 'no baseline for this image', failures: [] }
    const found = compareRegions(state.baseline.regions, await readRegions(state))
    if (found.length === 0) return { status: 'pass', failures: [], facts: { regions: 'sidebar, theme and Settings unchanged' } }
    return { status: 'fail', failures: found.map(clash => ({ ...classifyFailure('clashes', [`${clash.region}: ${clash.detail}`]), cause: 'studio-overlap', fixClass: 'delorun-shim' as const })) }
  })
}

/**
 * One cost sample: stop, start, wait for the home screen, read memory and console errors.
 * @param state - the run.
 * @returns the sample.
 */
export async function sampleCost(state: RunState): Promise<CostSample> {
  await state.box.script('ctl', ['studio-stop'], { timeoutMs: 60_000 })
  const started = await startStudio(state)
  const page = await browse(state, 'screens', ['--widths', '1440', '--name', 'cost'])
  const rss = await state.box.script('ctl', ['rss'])
  return { startMs: started.startMs, rssBytes: Number(rss.rssBytes ?? 0), consoleErrors: ((page.consoleErrors as string[] | undefined) ?? []).length }
}

/**
 * Stage 9: three runs with the plugin against the baseline's three.
 * @param state - the run.
 * @returns the result.
 */
export async function cost(state: RunState): Promise<StageResult> {
  return await timed('cost', async () => {
    if (!state.pluginOn) return { status: 'skipped', reason: 'the studio switched the plugin off before this stage', failures: [] }
    if (state.baseline === undefined) return { status: 'skipped', reason: 'no baseline for this image', failures: [] }
    const samples: CostSample[] = []
    for (let run = 0; run < COST_RUNS; run++) samples.push(await sampleCost(state))
    const findings = costFindings(samples, state.baseline.samples)
    const reported = findings.filter(finding => finding.reported)
    const facts = Object.fromEntries(findings.map(finding => [finding.metric, finding.reported ? `reported: ${finding.detail}` : 'within the noise of three runs']))
    if (reported.length === 0) return { status: 'pass', failures: [], facts }
    return { status: 'fail', failures: reported.map(finding => ({ signature: `cost: ${finding.metric}`, evidence: [finding.detail], cause: 'ui-error', fixClass: 'parked' as const })), facts }
  })
}

/**
 * Stage 10: remove the plugin and list what is left in the home.
 * @param state - the run.
 * @returns the result.
 */
export async function uninstall(state: RunState): Promise<StageResult> {
  return await timed('uninstall', async () => {
    await state.box.script('ctl', ['studio-stop'], { timeoutMs: 60_000 })
    const removed = await state.box.script('ctl', ['plugin-remove', state.packageName], { timeoutMs: 600_000 })
    if (!removed.ok) return { status: 'fail', failures: [classifyFailure('uninstall', String(removed.output ?? 'removal failed').split('\n').filter(line => line.trim() !== '').slice(-6))] }
    const after = ((await state.box.script('ctl', ['tree'])).files as string[] | undefined) ?? []
    const before = new Set(state.homeBefore)
    const left = after.filter(path => !before.has(path) && path.includes(state.packageName))
    if (left.length > 0) return { status: 'fail', failures: [{ signature: 'files of the plugin remain in the home', evidence: left.slice(0, 20), cause: 'files-in-home', fixClass: 'delorun-fix' }], facts: { 'left behind': left.length } }
    return { status: 'pass', failures: [], facts: { 'left behind': 0 } }
  })
}

/**
 * Read a text file the run wrote, for the card's notes.
 * @param path - the file.
 * @returns its text, or an empty string.
 */
export function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}
