/**
 * The installed-release smoke: installs one release from a release channel into a new scratch home with the launcher a
 * person runs, adds every pack the release offers through the studio's own route, restarts twice, and creates one chat,
 * with no model key and no model request. `cut-rc.ts` runs it as its last step.
 *
 * `tsx delorun/apps/release/scripts/installed-smoke.ts --channel <dir|origin> --version <v> [--launcher <tgz>]
 * [--keys <dir>] [--channel-port <n>] [--studio-port <n>] [--budget-minutes <n>] [--log <file>] [--keep-going]`
 *
 * A channel directory is served read-only on `127.0.0.1:<channel-port>` for the run, and the launcher is built from
 * this checkout for that origin (`npm-launcher/src/build.ts`). An origin is used as it is, with a launcher built for it
 * unless `--launcher` names one: a launcher's channel origin is fixed when it is built. Every `delorun` command runs as
 * `npx --package=<launcher tgz> -- delorun` with an environment of its own, as the preview's wrapper runs it:
 * `HOME`, `DELORUN_HOME`, `TMPDIR` and the npm cache inside the scratch directory, no model key. The launcher build
 * runs with the same environment.
 *
 * Steps, each named on failure: 1 install and start, 2 add the offered packs, 3 wait for the installs and check each
 * pack's plugins are loaded, 4 stop and start twice with a clean home log, 5 create a chat, 6 upgrade the previous release, installed with the Claude Code and Codex packs, to this one with `delorun update --yes --data-copy` and check both packs still load (needs `--keys`, whose `timestamp.pem` signs a snapshot of the channel that names the previous release; skipped, with its reason, without it, for a channel origin, or for a channel with no older release), 7 clean up. The scratch
 * directory `/var/tmp/itest-*` (outside `/tmp`, which a sandboxed command may write, as a real home is) is removed and every process the run started is stopped, whether it passes or not. The run
 * stops at the first failure; `--keep-going` records a failed check (a refused home-log line, a pack that is not loaded)
 * and goes on, so one run names every failing step. Exit codes: 0 passed, 1 a step or check failed, 2 a wrong command
 * line.
 *
 * @module installed-smoke
 */
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import type { Server } from 'node:http'
import { RUNTIME_PLATFORMS, type RuntimePlatform } from '@delorun/contract-release-manifest'
import { checkHolder, readHomeLock, SYSTEM_PROCESS_TABLE, type ProcessTable } from '@delorun/home'
import { repositoryRoot } from '@delorun/tools/src/git.ts'
import { serveChannel } from './local-channel.ts'
import { logProblems } from '../src/installed-smoke/home-log.ts'
import { channelSource, offeredPacks, type ChannelSource } from '../src/installed-smoke/offered-packs.ts'
import { previousRelease } from '../src/installed-smoke/previous-release.ts'
import { PREVIOUS_RELEASE_ANSWERS_SCHEMA_VERSION, SMOKE_ANSWERS_SCHEMA_VERSION, smokeAnswers } from '../src/installed-smoke/answers.ts'
import { writeSnapshot } from '../src/installed-smoke/snapshot.ts'
import { signIn, type StudioClient } from '../src/installed-smoke/studio.ts'
import type { QueueItem} from '../src/installed-smoke/wire.ts';
import { BundleView, PacksResult, PacksSnapshot, PluginView, readAnswer } from '../src/installed-smoke/wire.ts'

/** The ports the smoke uses by default: the team's scratch range, away from every Host a person runs. */
const DEFAULT_PORTS = { channel: 18981, studio: 18982 } as const

/** The profile the smoke sets up. */
const PROFILE = 'default'

/** What the command needs. */
export interface SmokeRequest {
  /** A channel directory or an `http(s)` origin. */
  readonly channel: string
  /** The release to install. */
  readonly version: string
  /** A launcher tarball to run instead of building one. */
  readonly launcher: string | undefined
  /** The port a channel directory is served on. */
  readonly channelPort: number
  /** The studio's port. */
  readonly studioPort: number
  /** The whole run's time budget, in minutes. */
  readonly budgetMinutes: number
  /** The file every command's output is appended to. */
  readonly log: string
  /** Record a failed check and go on to the next step, instead of stopping at it. */
  readonly keepGoing: boolean
  /** The directory holding `timestamp.pem`, which signs the snapshot step 6 installs the previous release from; step 6 is skipped without it. */
  readonly keys: string | undefined
}

/**
 * Parse the command line.
 * @param argv - the arguments after the script.
 * @returns the request.
 * @throws Error naming the first wrong or missing flag.
 */
export function parseSmokeArgs(argv: readonly string[]): SmokeRequest {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      'channel': { type: 'string' },
      'version': { type: 'string' },
      'launcher': { type: 'string' },
      'channel-port': { type: 'string', default: String(DEFAULT_PORTS.channel) },
      'studio-port': { type: 'string', default: String(DEFAULT_PORTS.studio) },
      'budget-minutes': { type: 'string', default: '30' },
      'log': { type: 'string' },
      'keep-going': { type: 'boolean', default: false },
      'keys': { type: 'string' },
    },
  })
  if (values.channel === undefined || values.channel === '') throw new Error('pass --channel <dir|origin>')
  if (values.version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u.test(values.version)) throw new Error('pass --version <release version>')
  const port = (name: 'channel-port' | 'studio-port'): number => {
    const value = Number(values[name])
    if (!Number.isInteger(value) || value < 1024 || value > 65_535) throw new Error(`--${name} is a port from 1024 to 65535, not ${values[name]!}`)
    return value
  }
  const budget = Number(values['budget-minutes'])
  if (!Number.isInteger(budget) || budget < 1 || budget > 240) throw new Error(`--budget-minutes is a whole number from 1 to 240, not ${values['budget-minutes']!}`)
  const remote = /^https?:\/\//u.test(values.channel)
  return {
    channel: remote ? values.channel.replace(/\/+$/u, '') : resolve(values.channel),
    version: values.version,
    launcher: values.launcher === undefined ? undefined : resolve(values.launcher),
    channelPort: port('channel-port'),
    studioPort: port('studio-port'),
    budgetMinutes: budget,
    log: resolve(values.log ?? join(tmpdir(), `installed-smoke-${values.version}.log`)),
    keepGoing: values['keep-going'],
    keys: values.keys === undefined ? undefined : resolve(values.keys),
  }
}

/** A step that failed: the runner prints its number and name with the reason. */
export class StepFailure extends Error {}

/** The smoke's steps, in order. */
export const SMOKE_STEPS = [
  'install the release and start the studio',
  'add every pack the release offers',
  'wait for the installs; check each pack is installed and its plugins are loaded',
  'stop and start twice; check the home log',
  'create a chat',
  'upgrade the previous release with the agent packs to this one',
  'clean up',
] as const

/** The result of one command. */
interface Finished {
  readonly status: number | null
  readonly stdout: string
  readonly output: string
}

/** How long the load check asks again while the Host's reload after the installs settles. */
const LOAD_SETTLE_MS = 90_000

/** Install list states of an item that is still working; the Host drops a finished item from the list at its reload. */
const WORKING_STATES = new Set(['queued', 'downloading', 'verifying', 'installing', 'needs-reload'])

/**
 * Whether the installs of the packs have ended, from the install list: none of them is still working.
 * @param packs - the pack names.
 * @param queue - the list's items.
 * @returns `working` with the items still working, or `ended` with the items that failed or were cancelled.
 */
export function installsState(packs: readonly string[], queue: readonly QueueItem[]): { readonly kind: 'working' | 'ended', readonly items: readonly QueueItem[] } {
  const ours = queue.filter(item => packs.includes(item.key))
  const working = ours.filter(item => WORKING_STATES.has(item.state))
  if (working.length > 0) return { kind: 'working', items: working }
  return { kind: 'ended', items: ours.filter(item => item.state !== 'ready') }
}

/**
 * The problems of the packs' bundles and loader entries after the installs: each pack must be an installed, enabled
 * bundle without an error, every row its patch inserts must have a live loader entry, and every enabled entry among
 * them must be active with no diagnostic.
 * @param packs - the pack names.
 * @param bundles - `pluginManager/listBundles`'s answer.
 * @param plugins - `pluginManager/listPlugins`'s answer.
 * @returns one line per problem; empty when every pack is loaded.
 */
export function loadProblems(packs: readonly string[], bundles: readonly BundleView[], plugins: readonly PluginView[]): string[] {
  const problems: string[] = []
  for (const name of packs) {
    const bundle = bundles.find(candidate => candidate.name === name)
    if (bundle === undefined) {
      problems.push(`${name}: the plugin manager lists no such bundle`)
      continue
    }
    if (!bundle.installed || !bundle.enabled) problems.push(`${name}: installed ${String(bundle.installed)}, enabled ${String(bundle.enabled)}`)
    if (bundle.error !== undefined) problems.push(`${name}: ${JSON.stringify(bundle.error)}`)
    if (bundle.rows.length === 0) problems.push(`${name}: its patch inserts no rows`)
    for (const row of bundle.rows) {
      const entry = row.entryId === undefined ? undefined : plugins.find(plugin => plugin.entryId === row.entryId)
      if (entry === undefined) problems.push(`${name}: row ${row.rowId} (${row.moduleName}) has no live loader entry`)
      else if (entry.enabled && (entry.fiberPhase !== 'active' || entry.diagnostic !== undefined)) problems.push(`${name}: row ${row.rowId} (${row.moduleName}) is ${String(entry.fiberPhase)}${entry.diagnostic === undefined ? '' : `: ${entry.diagnostic}`}`)
    }
  }
  return problems
}

/**
 * Format a duration.
 * @param milliseconds - the duration.
 * @returns `12 s` or `3 min 4 s`.
 */
function took(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000)
  return seconds < 60 ? `${String(seconds)} s` : `${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s`
}

/**
 * Run the smoke.
 * @param request - the request.
 * @param say - prints one line.
 * @returns 0 when every step passed, 1 when one failed.
 */
export async function runSmoke(request: SmokeRequest, say: (line: string) => void): Promise<0 | 1> {
  const began = Date.now()
  const deadline = began + request.budgetMinutes * 60_000
  const repository = repositoryRoot(process.cwd())
  const platform = `${process.platform}-${process.arch}`
  if (!(RUNTIME_PLATFORMS as readonly string[]).includes(platform)) {
    say(`installed smoke: Delorun publishes no runtime for ${platform}`)
    return 1
  }
  mkdirSync(dirname(request.log), { recursive: true })
  writeFileSync(request.log, `installed smoke of ${request.version} from ${request.channel}\n`)
  const scratch = mkdtempSync(join('/var/tmp', 'itest-'))
  const paths = { home: join(scratch, 'home'), delorun: join(scratch, 'home', '.delorun'), tmp: join(scratch, 'tmp'), npm: join(scratch, 'npm-cache'), project: join(scratch, 'home', 'project') }
  for (const directory of [paths.home, paths.tmp, paths.npm, paths.project]) mkdirSync(directory, { recursive: true, mode: 0o700 })
  let homeLog = join(paths.delorun, 'logs', `home-${PROFILE}`, 'home.log')
  let server: Server | undefined
  let launcher = request.launcher
  let started = false
  let step = 0
  /** Steps whose checks failed under `--keep-going`. */
  const failedSteps: number[] = []
  let stepBegan = began
  const begin = (index: number): void => {
    step = index
    stepBegan = Date.now()
    say(`[${String(index)}/${String(SMOKE_STEPS.length)}] ${SMOKE_STEPS[index - 1]!} ...`)
  }
  const done = (note = ''): void => say(`[${String(step)}/${String(SMOKE_STEPS.length)}] ${failedSteps.includes(step) ? 'finished with failed checks' : 'passed'} in ${took(Date.now() - stepBegan)}${note}`)
  const left = (): number => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new StepFailure(`the run's ${String(request.budgetMinutes)} minute budget ran out`)
    return remaining
  }

  let environment = smokeEnvironment(paths)
  /** The release `delorun status` must report running. */
  let expected = request.version
  /** Run a command, with its output appended to the run's log. */
  const command = (executable: string, args: readonly string[], timeoutMs: number, env: NodeJS.ProcessEnv = environment, cwd = paths.home): Promise<Finished> => new Promise((settle) => {
    appendFileSync(request.log, `$ ${executable} ${args.join(' ')}\n`)
    const child = spawn(executable, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let output = ''
    const take = (chunk: Buffer, out: boolean): void => {
      const text = chunk.toString()
      if (out) stdout += text
      output += text
      appendFileSync(request.log, redactTokens(text))
    }
    child.stdout.on('data', (chunk: Buffer) => take(chunk, true))
    child.stderr.on('data', (chunk: Buffer) => take(chunk, false))
    const timer = setTimeout(() => {
      appendFileSync(request.log, `[timed out after ${took(timeoutMs)}]\n`)
      child.kill('SIGTERM')
    }, timeoutMs)
    child.on('error', (error) => { clearTimeout(timer); output += error.message; settle({ status: null, stdout, output }) })
    child.on('close', (status) => { clearTimeout(timer); appendFileSync(request.log, `[exit ${String(status)}]\n`); settle({ status, stdout, output }) })
  })
  const npx = join(dirname(process.execPath), 'npx')
  const delorun = (args: readonly string[], timeoutMs: number): Promise<Finished> => command(npx, ['--yes', `--package=${launcher!}`, '--', 'delorun', ...args], Math.min(timeoutMs, left()))
  const required = async (args: readonly string[], timeoutMs: number): Promise<Finished> => {
    const finished = await delorun(args, timeoutMs)
    if (finished.status !== 0) throw new StepFailure(`delorun ${args.join(' ')} exited ${String(finished.status)}:\n${finished.output.trim().split('\n').slice(-25).join('\n')}`)
    return finished
  }
  /** The home log's length, so a check reads only what a start writes after it. */
  const logOffset = (): number => (existsSync(homeLog) ? statSync(homeLog).size : 0)
  const logSince = (offset: number): string => {
    if (!existsSync(homeLog)) return ''
    const size = statSync(homeLog).size
    const from = size < offset ? 0 : offset
    const buffer = Buffer.alloc(size - from)
    const descriptor = openSync(homeLog, 'r')
    try {
      readSync(descriptor, buffer, 0, buffer.length, from)
    } finally {
      closeSync(descriptor)
    }
    return buffer.toString('utf8')
  }
  /** A failed check: stop at it, or with `--keep-going` record it and go on. */
  const checkFailed = (reason: string): void => {
    if (!request.keepGoing) throw new StepFailure(reason)
    say(`installed smoke: CHECK FAILED in step ${String(step)} (${SMOKE_STEPS[step - 1]!}): ${reason}`)
    if (!failedSteps.includes(step)) failedSteps.push(step)
  }
  const checkLog = (offset: number, what: string): void => {
    const problems = logProblems(logSince(offset))
    if (problems.length > 0) checkFailed(`the home log of ${what} has ${String(problems.length)} refused line(s):\n${problems.join('\n')}`)
  }
  const status = async (): Promise<{ readonly running: string, readonly studio: string | undefined }> => {
    const answer = JSON.parse((await required(['status', '--json'], 60_000)).stdout) as { status?: { state?: string, runtime?: { running?: string }, studio?: string } }
    const running = answer.status?.runtime?.running
    if (answer.status?.state !== 'running' || running !== expected) throw new StepFailure(`delorun status --json says ${String(answer.status?.state)} with release ${String(running)}, not running ${expected}`)
    return { running, studio: answer.status.studio }
  }
  const studio = async (): Promise<StudioClient> => {
    const link = /(https?:\/\/\S+)/u.exec((await required(['open', '--print'], 60_000)).stdout)?.[1]
    if (link === undefined) throw new StepFailure('delorun open --print printed no link')
    return signIn(link)
  }
  const start = async (what: string): Promise<void> => {
    const offset = logOffset()
    await required(['start'], 300_000)
    started = true
    const { studio: address } = await status()
    if (address !== undefined && new URL(address).port !== String(request.studioPort)) throw new StepFailure(`the studio listens on ${address}, not port ${String(request.studioPort)}`)
    checkLog(offset, what)
  }
  /** Call a packs route: `list` answers the snapshot, the others a result that holds it. */
  const packsView = async (client: StudioClient, route: 'list' | 'enqueue', body: object): Promise<PacksSnapshot> => {
    const answer = await client.route(`/api/delorunPacks.${route}`, body)
    if (route === 'list') return readAnswer(PacksSnapshot, answer, `delorunPacks.${route}`)
    const result = readAnswer(PacksResult, answer, `delorunPacks.${route}`)
    if (!result.ok) throw new StepFailure(`delorunPacks.${route} refused: ${result.error.code}: ${result.error.message}`)
    return result.value
  }
  /** Check every pack is loaded, asking again for up to {@link LOAD_SETTLE_MS} while the Host's reload settles. */
  const loaded = async (client: StudioClient, packs: readonly string[]): Promise<void> => {
    const until = Math.min(Date.now() + LOAD_SETTLE_MS, deadline)
    for (;;) {
      let problems: string[]
      try {
        const bundles = readAnswer(z.array(BundleView), await client.rpc('pluginManager/listBundles', {}), 'pluginManager/listBundles')
        problems = loadProblems(packs, bundles, readAnswer(z.array(PluginView), await client.rpc('pluginManager/listPlugins', {}), 'pluginManager/listPlugins'))
      } catch (error) {
        problems = [`the plugin manager did not answer: ${error instanceof Error ? error.message : String(error)}`]
      }
      if (problems.length === 0) return
      if (Date.now() + 3000 > until) {
        checkFailed(`${String(problems.length)} pack problem(s):\n${problems.join('\n')}`)
        return
      }
      await new Promise(wait => setTimeout(wait, 3000))
    }
  }
  /** The install list, read again after a request error while the Host reloads; a refused sign-in signs in again. */
  const installList = async (current: StudioClient): Promise<{ readonly client: StudioClient, readonly queue: readonly QueueItem[] }> => {
    let client = current
    for (;;) {
      try {
        return { client, queue: (await packsView(client, 'list', {})).queue }
      } catch (error) {
        if (error instanceof StepFailure || Date.now() + 2000 > deadline) throw error
        appendFileSync(request.log, `install list: ${error instanceof Error ? error.message : String(error)}; asking again\n`)
        await new Promise(wait => setTimeout(wait, 2000))
        if (error instanceof Error && error.message.includes('HTTP 401')) client = await studio()
      }
    }
  }

  /** Wait for the installs of the packs to end, then check none failed; returns a client signed in after the Host's reload. */
  const awaitInstalls = async (first: StudioClient, packs: readonly string[]): Promise<StudioClient> => {
    let client = first
    let lastNote = Date.now()
    let polled = await installList(client)
    let installs = installsState(packs, polled.queue)
    while (installs.kind === 'working') {
      const states = installs.items.map(item => `${item.key} ${item.state}`).join(', ')
      if (Date.now() + 2000 > deadline) throw new StepFailure(`the installs did not finish within the budget: ${states}`)
      if (Date.now() - lastNote >= 30_000) {
        say(`      after ${took(Date.now() - stepBegan)}: ${states}`)
        lastNote = Date.now()
      }
      await new Promise(wait => setTimeout(wait, 2000))
      polled = await installList(polled.client)
      installs = installsState(packs, polled.queue)
    }
    const unfinished = installs.items
    if (unfinished.length > 0) throw new StepFailure(`${String(unfinished.length)} pack install(s) did not finish:\n${unfinished.map(item => `${item.key}: ${item.state}${item.failure === undefined ? '' : ` (${item.failure.code}: ${item.failure.message})`}`).join('\n')}`)
    // The single Host reload after the installs signs the page out of nothing, but a new link is cheap and certain.
    client = await studio()
    return client
  }

  let code: 0 | 1 = 0
  /** The scratch homes besides the first, for clean-up. */
  const extraHomes: string[] = []
  try {
    begin(1)
    const source = channelSource(request.channel)
    const packs = await offeredPacks(source, request.version, platform as RuntimePlatform, Math.floor(Date.now() / 1000))
    say(`      ${request.version} offers ${String(packs.length)} pack(s) for ${platform}: ${packs.join(', ') || 'none'}`)
    let origin = request.channel
    if (!/^https?:\/\//u.test(request.channel)) {
      server = (await serveChannel({ channel: request.channel, port: request.channelPort, host: '127.0.0.1', log: line => appendFileSync(request.log, `channel: ${line}\n`) })).server
      origin = `http://127.0.0.1:${String(request.channelPort)}`
      say(`      serving ${request.channel} read-only at ${origin}`)
    }
    if (launcher === undefined) {
      const out = join(scratch, 'launcher')
      const roots = await channelRoots(source, join(scratch, 'roots'))
      const built = await command(join(repository, 'node_modules/.bin/tsx'), ['delorun/apps/npm-launcher/src/build.ts', ...roots.flatMap(file => ['--root', file]), '--out', out, '--channel-origin', origin, '--package-version', request.version], 300_000, environment, repository)
      if (built.status !== 0) throw new StepFailure(`the launcher build failed:\n${built.output.trim().split('\n').slice(-15).join('\n')}`)
      launcher = join(out, `delorun-${request.version}.tgz`)
    }
    const answers = join(scratch, 'setup-answers.json')
    writeFileSync(answers, smokeAnswers(SMOKE_ANSWERS_SCHEMA_VERSION, request.studioPort))
    await required(['setup', '--config', answers], 900_000)
    await start('the first start')
    done(` (${request.version} running, studio on port ${String(request.studioPort)})`)

    begin(2)
    let client = await studio()
    const offered = await packsView(client, 'list', {})
    if (!offered.supported) throw new StepFailure(`the studio supports no packs: ${String(offered.reason)}`)
    const listed = offered.packs.map(pack => pack.name).sort()
    if (JSON.stringify(listed) !== JSON.stringify(packs)) throw new StepFailure(`the studio offers ${listed.join(', ') || 'no packs'}, the packs file ${packs.join(', ') || 'none'}`)
    const installOffset = logOffset()
    if (packs.length > 0) await packsView(client, 'enqueue', { names: packs })
    done(packs.length === 0 ? ' (the release offers no packs)' : ` (${String(packs.length)} queued)`)

    begin(3)
    client = await awaitInstalls(client, packs)
    await loaded(client, packs)
    checkLog(installOffset, 'the installs')
    done(` (${String(packs.length)} installed and loaded)`)

    begin(4)
    for (const round of [1, 2]) {
      await required(['stop'], 120_000)
      started = false
      await start(`restart ${String(round)}`)
      await loaded(await studio(), packs)
      say(`      restart ${String(round)}: running ${request.version}, every pack loaded, home log clean`)
    }
    done()

    begin(5)
    client = await studio()
    const created = await client.rpc('session/create', { request: { cwd: paths.project } }).catch((error: unknown) => {
      throw new StepFailure(`session/create failed with every pack installed: ${error instanceof Error ? error.message : String(error)}`)
    }) as { sessionId?: unknown }
    if (typeof created.sessionId !== 'string' || created.sessionId === '') throw new StepFailure(`session/create answered no session id: ${JSON.stringify(created)}`)
    done(` (chat ${created.sessionId})`)

    begin(6)
    const previous = /^https?:\/\//u.test(request.channel) ? undefined : await previousRelease(request.channel, request.version)
    if (request.keys === undefined) {
      done(' (skipped: pass --keys <dir with timestamp.pem>; the launcher installs an older release only from a channel whose timestamp names it)')
    } else if (previous === undefined) {
      done(/^https?:\/\//u.test(request.channel) ? ' (skipped: a channel origin lists no releases to start from)' : ` (skipped: the channel holds no release older than ${request.version})`)
    } else {
      const agentPacks = (await offeredPacks(source, previous, platform as RuntimePlatform, Math.floor(Date.now() / 1000))).filter(name => /subagent-(?:claude-code|codex)$/u.test(name))
      if (agentPacks.length !== 2) {
        done(` (skipped: ${previous} offers ${String(agentPacks.length)} of the Claude Code and Codex packs for ${platform})`)
      } else {
        await required(['stop'], 120_000)
        started = false
        // The previous release installs from a snapshot whose timestamp names it, served on the live channel's port.
        const snapshot = join(scratch, 'snapshot')
        const snapshotVersion = await writeSnapshot({ channel: request.channel, directory: snapshot, release: previous, timestampKey: join(request.keys, 'timestamp.pem'), now: Math.floor(Date.now() / 1000) })
        say(`      snapshot of the channel at ${previous}, timestamp version ${String(snapshotVersion)}`)
        const serve = async (directory: string): Promise<void> => {
          await new Promise<void>(closed => (server === undefined ? closed() : server.close(() => closed())))
          server = (await serveChannel({ channel: directory, port: request.channelPort, host: '127.0.0.1', log: line => appendFileSync(request.log, `channel: ${line}\n`) })).server
        }
        await serve(snapshot)
        const upgrade = join(scratch, 'upgrade')
        const upgradePaths = { home: join(upgrade, 'home'), delorun: join(upgrade, 'home', '.delorun'), tmp: join(upgrade, 'tmp'), npm: join(upgrade, 'npm-cache'), project: join(upgrade, 'home', 'project') }
        for (const directory of [upgradePaths.home, upgradePaths.tmp, upgradePaths.npm, upgradePaths.project]) mkdirSync(directory, { recursive: true, mode: 0o700 })
        extraHomes.push(upgradePaths.delorun)
        const oldLauncher = join(scratch, 'launcher-previous')
        const roots = await channelRoots(source, join(scratch, 'roots-previous'))
        const built = await command(join(repository, 'node_modules/.bin/tsx'), ['delorun/apps/npm-launcher/src/build.ts', ...roots.flatMap(file => ['--root', file]), '--out', oldLauncher, '--channel-origin', origin, '--package-version', previous], 300_000, environment, repository)
        if (built.status !== 0) throw new StepFailure(`the launcher build for ${previous} failed:\n${built.output.trim().split('\n').slice(-15).join('\n')}`)
        // From here every command runs in the upgrade home, with the previous release's launcher.
        launcher = join(oldLauncher, `delorun-${previous}.tgz`)
        environment = smokeEnvironment(upgradePaths)
        homeLog = join(upgradePaths.delorun, 'logs', `home-${PROFILE}`, 'home.log')
        expected = previous
        // The previous release may refuse this release's answers version, so it gets its own document.
        const previousAnswers = join(scratch, 'setup-answers-previous.json')
        writeFileSync(previousAnswers, smokeAnswers(PREVIOUS_RELEASE_ANSWERS_SCHEMA_VERSION, request.studioPort))
        await required(['setup', '--config', previousAnswers], 900_000)
        await start(`the first start of ${previous}`)
        let old = await studio()
        await packsView(old, 'enqueue', { names: agentPacks })
        old = await awaitInstalls(old, agentPacks)
        await loaded(old, agentPacks)
        say(`      ${previous} runs with ${agentPacks.join(' and ')} loaded`)
        await serve(request.channel)
        const updateOffset = logOffset()
        await required(['update', '--yes', '--data-copy'], 900_000)
        expected = request.version
        await status()
        await loaded(await studio(), agentPacks)
        checkLog(updateOffset, `the update from ${previous}`)
        done(` (${previous} updated to ${request.version}, both agent packs loaded)`)
      }
    }
  } catch (error) {
    code = 1
    const reason = error instanceof Error ? error.message : String(error)
    say(`installed smoke: FAILED at step ${String(step)} (${SMOKE_STEPS[step - 1] ?? 'setup'}): ${reason}`)
  }
  if (failedSteps.length > 0) {
    code = 1
    say(`installed smoke: checks failed in step(s) ${failedSteps.join(', ')}`)
  }
  if (code !== 0) say(`installed smoke: every command's output is in ${request.log}`)

  begin(7)
  try {
    if (started && launcher !== undefined) {
      const stopped = await command(npx, ['--yes', `--package=${launcher}`, '--', 'delorun', 'stop'], 120_000)
      if (stopped.status !== 0) say(`      delorun stop exited ${String(stopped.status)}`)
    }
    for (const delorunHome of [paths.delorun, ...extraHomes]) stopLeftover(delorunHome, say)
    await new Promise<void>(closed => (server === undefined ? closed() : server.close(() => closed())))
    await command('chmod', ['-R', 'u+w', scratch], 120_000, { PATH: '/usr/bin:/bin' }, '/')
    await rm(scratch, { recursive: true, force: true })
    done(` (removed ${scratch})`)
  } catch (error) {
    code = 1
    say(`installed smoke: FAILED at step 7 (clean up): ${error instanceof Error ? error.message : String(error)}; remove ${scratch} by hand`)
  }
  say(`installed smoke of ${request.version}: ${code === 0 ? 'PASSED' : 'FAILED'} in ${took(Date.now() - began)}`)
  return code
}

/**
 * Text for the run's log with each sign-in link's token left out; the run reads the link from the command's own output.
 * @param text - command output.
 * @returns the text with each `token=` value replaced.
 */
export function redactTokens(text: string): string {
  return text.replace(/([?&]token=)[^\s&#]+/gu, '$1<redacted>')
}

/**
 * Copy a channel's root files into a directory, for the launcher build.
 * @param source - the channel.
 * @param directory - a new directory.
 * @returns the copied files, oldest first.
 */
async function channelRoots(source: ChannelSource, directory: string): Promise<string[]> {
  mkdirSync(directory, { recursive: true })
  const files: string[] = []
  for (let index = 1; ; index++) {
    const bytes = await source.read(`root/${String(index)}.root.json`)
    if (bytes === undefined) return files
    const file = join(directory, `${String(index)}.root.json`)
    writeFileSync(file, bytes)
    files.push(file)
  }
}

/** The scratch folders a run's commands use. */
export interface SmokePaths {
  /** `HOME`. */
  readonly home: string
  /** `DELORUN_HOME`. */
  readonly delorun: string
  /** `TMPDIR`. */
  readonly tmp: string
  /** The npm cache. */
  readonly npm: string
}

/**
 * The environment every command of a run gets, the launcher build included: the scratch folders, Node's own folder and
 * the system folders on `PATH`, and nothing else of this process's environment but `USER`, so no model key, token or
 * npm setting of the person running the cut reaches it.
 * @param paths - the run's scratch folders.
 * @param user - the user name; this process's by default.
 * @returns the environment.
 */
export function smokeEnvironment(paths: SmokePaths, user: string = process.env['USER'] ?? 'delorun'): NodeJS.ProcessEnv {
  return {
    HOME: paths.home,
    USER: user,
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    TMPDIR: paths.tmp,
    PATH: [dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    npm_config_cache: paths.npm,
    npm_config_update_notifier: 'false',
    DELORUN_HOME: paths.delorun,
  }
}

/**
 * Stop a home process `delorun stop` left running: the process the profile's home lock names, by its pid, and only
 * while the lock's holder is confirmed to be that process ({@link checkHolder}), so a pid the system has since given
 * to another process is left alone.
 * @param delorunHome - the scratch Delorun home.
 * @param say - prints one line.
 * @param table - the processes to check the holder against; this operating system's by default.
 * @throws Error when the lock file is not a home lock record.
 */
export function stopLeftover(delorunHome: string, say: (line: string) => void, table: ProcessTable = SYSTEM_PROCESS_TABLE): void {
  const record = readHomeLock(join(delorunHome, 'run', PROFILE))
  if (record === undefined) return
  const check = checkHolder(record, table)
  if (check.kind !== 'confirmed') {
    if (check.kind === 'unconfirmed') say(`      left process ${String(record.pid)} running: the home lock names it, but it cannot be confirmed as the home process (${check.reason})`)
    return
  }
  try {
    process.kill(record.pid, 'SIGKILL')
    say(`      stopped the home process ${String(record.pid)} that delorun stop left running`)
  } catch (error) {
    // ESRCH: the process ended between the check and the signal.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/**
 * Run the command.
 * @param argv - the arguments after the script.
 * @returns the exit code.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let request: SmokeRequest
  try {
    request = parseSmokeArgs(argv)
  } catch (error) {
    console.error(`installed smoke: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  return runSmoke(request, line => console.log(line))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
