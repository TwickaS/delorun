/**
 * Stage 7, the update: the plugin is installed on the previous release's image, its home is carried to a container of
 * the candidate's image in a run-scoped Docker volume (deleted afterwards), and the plugin must still load, draw and
 * keep its files. This is a home carried across versions, not a launcher update.
 *
 * @module @delorun/tools/compat-bench/update
 */
import { docker } from './docker.ts'
import { startBox, type Box } from './box.ts'
import type { StageResult } from './card.ts'
import { classifyFailure } from './classify.ts'
import { browse, install, screens, start, timed, type RunState } from './stages.ts'

/**
 * Whether an image exists.
 * @param tag - the tag.
 * @returns true when Docker has it.
 */
export async function imageExists(tag: string): Promise<boolean> {
  return (await docker(['image', 'inspect', tag, '--format', '{{.Id}}'])).code === 0
}

/**
 * A state for a container of the update stage.
 * @param box - the container.
 * @param run - the run's own state.
 * @param image - the image the container runs.
 * @returns the state.
 */
function stateFor(box: Box, run: RunState, image: string): RunState {
  return { ...run, box, image, installed: false, started: false, installSpec: run.installSpec, notes: [], homeBefore: [], baseline: undefined }
}

/**
 * Run the update stage.
 * @param run - the run's state; the plugin, images and folders come from it.
 * @returns the result; skipped when an image is missing.
 */
export async function updateStage(run: RunState): Promise<StageResult> {
  const request = { runId: run.runId, prevImage: run.prevImage, candidateImage: run.image, outDir: run.outDir, user: `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`, packageName: run.packageName }
  const missing = [request.prevImage, request.candidateImage].filter(tag => tag !== '')
  for (const tag of missing) {
    if (!await imageExists(tag)) return { name: 'update', status: 'skipped', reason: `the image ${tag} is not built (run bench image build)`, durationMs: 0, failures: [] }
  }
  const volume = `bench-home-${request.runId}`
  return await timed('update', async () => {
    const created = await docker(['volume', 'create', '--label', 'delorun.bench=1', '--label', `delorun.bench.run=${request.runId}`, volume])
    if (created.code !== 0) throw new Error(`could not create the home volume: ${created.stderr.trim()}`)
    let previous: Box | undefined
    let candidate: Box | undefined
    try {
      previous = await startBox({ name: `bench-${request.runId}-prev`, image: request.prevImage, runId: request.runId, outDir: request.outDir, user: request.user, homeVolume: volume })
      const before = stateFor(previous, run, request.prevImage)
      await previous.script('ctl', ['setup'], { timeoutMs: 300_000 })
      await previous.script('ctl', ['mock-start'])
      if ((await install(before)).status !== 'pass') return { status: 'fail', failures: [classifyFailure('update', ['the plugin did not install on the previous release'])] }
      if ((await start(before)).status !== 'pass') return { status: 'fail', failures: [classifyFailure('update', ['the plugin did not start on the previous release'])] }
      const filesBefore = ((await previous.script('ctl', ['tree'])).files as string[] | undefined) ?? []
      await previous.script('ctl', ['studio-stop'], { timeoutMs: 60_000 })
      await previous.remove()
      previous = undefined
      candidate = await startBox({ name: `bench-${request.runId}-new`, image: request.candidateImage, runId: request.runId, outDir: request.outDir, user: request.user, homeVolume: volume })
      const after = stateFor(candidate, run, request.candidateImage)
      await candidate.script('ctl', ['mock-start'])
      const started = await start(after)
      if (started.status !== 'pass') return { status: 'fail', failures: started.failures.length > 0 ? started.failures : [classifyFailure('update', ['the studio did not start on the candidate with the carried home'])] }
      const drawn = await screens(after)
      const filesAfter = new Set(((await candidate.script('ctl', ['tree'])).files as string[] | undefined) ?? [])
      const lost = filesBefore.filter(path => path.includes(request.packageName) && !filesAfter.has(path))
      const answered = await browse(after, 'chat')
      if (drawn.status !== 'pass') return { status: 'fail', failures: drawn.failures, ...(drawn.shots === undefined ? {} : { shots: drawn.shots }) }
      if (lost.length > 0) return { status: 'fail', failures: [{ signature: 'plugin files are gone after the update', evidence: lost.slice(0, 20), cause: 'files-in-home', fixClass: 'delorun-fix' }] }
      if (!answered.ok) return { status: 'fail', failures: [classifyFailure('harness', [String(answered.error ?? 'no reply after the update')])] }
      return { status: 'pass', failures: [], facts: { 'plugin files kept': filesBefore.filter(path => path.includes(request.packageName)).length } }
    } finally {
      await previous?.remove()
      await candidate?.remove()
      await docker(['volume', 'rm', '-f', volume])
    }
  })
}
