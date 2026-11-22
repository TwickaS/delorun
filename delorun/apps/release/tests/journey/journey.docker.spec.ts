/**
 * The journey: one release built from the worktree, installed in a clean container the way a person installs it, and
 * walked through what a person does with it, from the first `npx` to an import into a second computer. The steps run in
 * order against one container whose home carries over from step to step; each test's name says which step failed.
 *
 * Parts, all made by the spec: throwaway root, targets, timestamp and log keys; release 1 built by `build-closure.ts
 * --artifacts existing` from the worktree's built artifacts (the closure build refuses, naming the cause, when the
 * worktree is not clean at its commit or an artifact is missing or older than its sources); releases 2, 2b, 3 and a
 * tampered release made from release 1's closure (`parts.ts`); the fixture plugin; a launcher built with the run's root
 * and the spec's channel and log origins; and a container image with the pinned Node and nothing of the repository,
 * whose containers reach only the spec's servers (`machine.ts`).
 *
 * The check runner runs this spec as the merge-only check `journey` with `DELORUN_JOURNEY=1`; `delorun/vitest.docker.config.ts`
 * leaves it out of the Docker lane. Without a Docker engine the runner declines the check; run by hand without an engine
 * the spec fails, naming the engine.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closureFileNames } from '../../src/closure/tree.ts'
import { engineProblem, exec, interact, journeyContainer, journeyImage, journeyNetwork, MOUNT, PERSON_HOME, removeNetwork, SHARED, type Finished, type Network } from './machine.ts'
import { buildBaseClosure, deriveInChild, launcher, packFixture, pins, publish, RELEASE_CACHE, runTrust, type BaseClosure, type RunTrust } from './parts.ts'
import { MODEL_REPLY, serveChannel, serveJourneyLog, serveModel, type JourneyLog, type Running } from './servers.ts'

/** The runner sets this for the `journey` check. */
const SELECTED = process.env['DELORUN_JOURNEY'] === '1'

/**
 * A directory holding release 1's archive and file list from an earlier `build-closure.ts --version 0.1.0 --platform
 * linux-x64 --artifacts existing` run, which a person working on this spec sets to skip the build; the check never sets it.
 */
const REUSED_CLOSURE = process.env['DELORUN_JOURNEY_CLOSURE']

/** The releases, in the order the channel names them. */
const R1 = '0.1.0'
const R2 = '0.2.0'
const R2B = '0.2.1'
const R3 = '0.3.0'
const R4 = '0.4.0'

/** The Delorun home in the containers. */
const HOME = `${PERSON_HOME}/.delorun`
const PROFILE = `${HOME}/profiles/default`

/** One step's limit; a step that starts the Host several times needs minutes. */
const STEP = 1_800_000

/** The fixture plugin's package name. */
const FIXTURE = 'delorun-journey-engines-fixture'

/** The bundle the person installs and turns off. */
const EXTRA = 'delorun-journey-extra-fixture'

/** What a run measured, printed at the end. */
const timings: Array<{ readonly what: string, readonly seconds: number }> = []
const runStarted = Date.now()

/**
 * Time one part of the run.
 * @param what - its name.
 * @param work - the work.
 * @returns the work's value.
 */
async function timed<T>(what: string, work: () => Promise<T>): Promise<T> {
  const started = Date.now()
  try {
    return await work()
  } finally {
    timings.push({ what, seconds: Math.round((Date.now() - started) / 100) / 10 })
  }
}

/** Everything the steps share. */
interface Journey {
  readonly scratch: string
  readonly shared: string
  readonly trust: RunTrust
  readonly base: BaseClosure
  /** Releases 2, 2b, 3 and the tampered release, made while steps 1 to 3 run, by version. */
  readonly releases: Promise<Readonly<Record<string, string>>>
  readonly channel: string
  readonly channelServer: Running
  readonly log: JourneyLog
  readonly model: MockLlmServer
  readonly launcherFile: string
  readonly fixtureFile: string
  readonly extraFile: string
  readonly network: Network
  /** The person's computer. */
  readonly machine: string
  /** The second computer step 11 imports into. */
  readonly second: string
  readonly env: Readonly<Record<string, string>>
}

let journey: Journey | undefined
let network: Network | undefined
const closers: Array<() => Promise<void>> = []

/** The journey's state, or the reason the parts were not made. */
function parts(): Journey {
  if (journey === undefined) throw new Error('the journey\'s parts were not made; see the first failure above')
  return journey
}

/**
 * Run a command in the person's computer.
 * @param args - the command.
 * @param env - variables over the journey's.
 * @param container - another container than the person's computer.
 * @returns the finished command.
 */
function run(args: readonly string[], env: Readonly<Record<string, string>> = {}, container?: string): Promise<Finished> {
  const { machine, env: base } = parts()
  return exec(container ?? machine, args, { ...base, ...env })
}

/**
 * Run `delorun` as the person does once the launcher is installed: the launcher's `bin` on their `PATH`.
 * @param args - the arguments.
 * @param env - variables over the journey's.
 * @param container - another container than the person's computer.
 * @returns the finished command.
 */
function delorun(args: readonly string[], env: Readonly<Record<string, string>> = {}, container?: string): Promise<Finished> {
  return run(['delorun', ...args], env, container)
}

/**
 * What holds the profile's writer lock: the lock file, then every process with its parent, group, state and command.
 * `ps` is not in the machine image, so this reads `/proc`.
 * @returns the lines, for a failed assertion's message.
 */
async function lockProbe(): Promise<string> {
  const script = 'cat /home/person/.delorun/profiles/default/package.json.lock; for p in /proc/[0-9]*; do read -r line < "$p/stat" 2>/dev/null || continue; printf "%s | %s\\n" "$line" "$(tr "\\0" " " < "$p/cmdline" 2>/dev/null)"; done'
  const probed = await run(['sh', '-c', script])
  return `${probed.stdout}\n${probed.stderr}`
}

/**
 * Parse a command's one-line JSON output.
 * @param finished - the command.
 * @returns the value.
 */
function json<T>(finished: Finished): T {
  const line = finished.stdout.trim().split('\n').at(-1) ?? ''
  try {
    return JSON.parse(line) as T
  } catch (_notJson) {
    // The message below names the command's output, which the parse error does not.
    throw new Error(`expected one JSON line, got status ${String(finished.status)}:\n${finished.stdout}\n${finished.stderr}`)
  }
}

/**
 * Hash every file and link below directories of the person's home.
 * @param paths - absolute paths in the container.
 * @returns path to SHA-256 or link target.
 */
async function hashes(...paths: readonly string[]): Promise<Record<string, string>> {
  return json<Record<string, string>>(await run(['node', `${MOUNT}/home.mjs`, 'hash', ...paths]))
}

/**
 * Every file below directories of the person's home with its size and modification time, for the runtime store,
 * which is too large to hash within a prompt's wait.
 * @param paths - absolute paths in the container.
 * @returns path to size and time, or link target.
 */
async function stats(...paths: readonly string[]): Promise<Record<string, string>> {
  return json<Record<string, string>>(await run(['node', `${MOUNT}/home.mjs`, 'stat', ...paths]))
}

/**
 * Read a JSON file in the person's computer.
 * @param path - the file.
 * @returns its value.
 */
async function readJson<T>(path: string, container?: string): Promise<T> {
  const read = await run(['cat', path], {}, container)
  if (read.status !== 0) throw new Error(`${path} could not be read: ${read.stderr}`)
  return JSON.parse(read.stdout) as T
}

/**
 * Ask the running studio something through the person's browser (`probe.mjs`).
 * @param args - the probe's action and arguments.
 * @returns the probe's value.
 * @throws Error naming the action and why it failed.
 */
async function probe<T>(...args: readonly string[]): Promise<T> {
  const answer = json<{ ok: boolean, value?: T, error?: string }>(await run(['node', `${MOUNT}/probe.mjs`, ...args]))
  if (!answer.ok) throw new Error(`the studio did not answer ${args[0] ?? ''}: ${answer.error ?? ''}`)
  return answer.value as T
}

/** The stand-in for the person's browser: it records each address the Host hands it, as a browser would open it. */
const BROWSER_SCRIPT = `#!/bin/sh\nmkdir -p ${PERSON_HOME}/.journey-browser && printf '%s\\n' "$1" >> ${PERSON_HOME}/.journey-browser/opened\n`

/**
 * A row's own id: the last segment of its Loader entry id, which nests it under its Include, such as `include:delorun-trash`.
 * @param row - the row.
 * @returns the id the profile's patch rows name.
 */
function rowId(row: Pick<Row, 'entryId'>): string {
  return row.entryId.split(':').at(-1)!
}

/** One Loader row as the studio's plugin inventory lists it. */
interface Row {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: string | null
  readonly diagnostic?: string
}

/** Every Loader row of the running Host. */
async function rows(): Promise<readonly Row[]> {
  return (await probe<{ entries: Row[] }>('rows')).entries
}

/**
 * The enabled rows that are not active, each with its module and diagnostic.
 * @param listed - the rows.
 * @returns one line per inactive enabled row.
 */
function inactive(listed: readonly Row[]): string[] {
  return listed.filter(row => row.enabled && row.fiberPhase !== 'active').map(row => `${row.entryId} (${row.moduleName}): ${String(row.fiberPhase)}${row.diagnostic === undefined ? '' : ` — ${row.diagnostic}`}`)
}

/**
 * Write a chat through the studio and wait for the model's reply.
 * @param text - the prompt.
 * @returns the chat's id.
 */
async function chat(text: string): Promise<string> {
  await run(['mkdir', '-p', `${PERSON_HOME}/work`])
  return (await probe<{ sessionId: string }>('chat', `${PERSON_HOME}/work`, text, MODEL_REPLY)).sessionId
}

/**
 * The files of a chat under a directory of the home's chat data: upstream keeps each chat in a directory named for it,
 * compressed, so the chat is found by its path.
 * @param sessionId - the chat.
 * @param directory - the directory to search, the home's `sessions/` by default.
 * @returns the paths.
 */
async function chatFiles(sessionId: string, directory = `${HOME}/sessions`, container?: string): Promise<string[]> {
  return json<string[]>(await run(['node', `${MOUNT}/home.mjs`, 'named', directory, sessionId], {}, container))
}

/** The Delorun version the home process runs, or `undefined` when none runs. */
async function running(): Promise<string | undefined> {
  const answer = json<{ ok: boolean, status?: { runtime: { running: string } } }>(await delorun(['status', '--json']))
  return answer.ok ? answer.status?.runtime.running : undefined
}

/** Start Delorun when no home process runs, so a step does not fail for what an earlier step left. */
async function ensureRunning(): Promise<void> {
  if (await running() !== undefined) return
  const started = await delorun(['start'])
  if (started.status !== 0) throw new Error(`delorun start failed: ${started.stdout}\n${started.stderr}`)
}

/** The person's customisations as files, for comparing before and after an update. */
async function customisations(): Promise<Record<string, string>> {
  const files = await hashes(`${PROFILE}/package.json`, `${PROFILE}/cordis.patch.yml`, `${HOME}/skills`, `${PROFILE}/node_modules/${FIXTURE}`, `${PROFILE}/node_modules/${EXTRA}`)
  // The profile's files may be rewritten byte for byte by a restore; their content is what has to survive.
  return files
}

/** The lines of a command's standard error that are not npm's own. */
function launcherLines(finished: Finished): string[] {
  return finished.stderr.split('\n').filter(line => line !== '' && !line.startsWith('npm '))
}

/**
 * The checklist a launcher install prints to a log, without the durations and the percentage lines, whose number depends
 * on the sizes and the speed of the machine.
 */
function installChecklist(finished: Finished): string[] {
  return launcherLines(finished).filter(line => !/^ {2}\d+%/u.test(line)).map(line => line.replace(/ {2}\d+(\.\d)?s$|  \d+m \d{2}s$/u, ''))
}

/** What step 3 customised, for later steps to find again. */
const customised: { files?: Record<string, string>, removedBundle?: string, disabledRow?: string | undefined, presetId?: string } = {}
/** The rows step 1 found, from which step 3 picks the row the person turns off. */
let firstRows: readonly Row[] = []
/** The chats the steps wrote. */
const chats: { first?: string, second?: string } = {}

describe.runIf(SELECTED)('the journey of an installed release', () => {
  beforeAll(async () => {
    const problem = engineProblem()
    if (problem !== undefined) throw new Error(`the journey needs a Docker engine: ${problem}. Start Docker and run the check again`)
    const scratch = mkdtempSync(join(tmpdir(), 'delorun-journey-'))
    closers.push(async () => {
      // Extracted closures hold read-only files; they are made writable before the directory goes.
      execFileSync('chmod', ['-R', 'u+rwX', scratch], { timeout: 120_000 })
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
    })
    const shared = join(scratch, 'shared')
    await mkdir(shared)
    const trust = await runTrust(scratch)
    const log = await serveJourneyLog(trust.trusted)
    closers.push(() => log.close())
    const channel = join(scratch, 'channel')
    await mkdir(channel)
    const channelServer = await serveChannel(channel)
    closers.push(() => channelServer.close())
    const model = await serveModel()
    closers.push(() => model.close())
    const base = await timed('build release 1\'s closure from the worktree\'s artifacts', () => buildBaseClosure(scratch, R1, REUSED_CLOSURE))
    // The later releases are made while the first steps run; the step that publishes one waits for it.
    const releases = timed('make releases 2, 2b, 3 and the tampered release, beside steps 1 to 3', async () => {
      // Each in a process of its own, so the archiving leaves this process free to answer the containers.
      const [two, twoB, three, four] = await Promise.all([
        deriveInChild(base, scratch, R2, 'none'),
        deriveInChild(base, scratch, R2B, 'studio-without-index'),
        deriveInChild(base, scratch, R3, 'chat-states-v2'),
        deriveInChild(base, scratch, R4, 'tampered'),
      ])
      return { [R1]: base.directory, [R2]: two, [R2B]: twoB, [R3]: three, [R4]: four } as Record<string, string>
    })
    // A failure is reported by the first step that waits for the releases.
    releases.catch(() => undefined)
    await timed('publish release 1', () => publish(trust, log, channel, R1, base.directory))
    const built = await timed('build the launcher', () => launcher(trust, scratch, channelServer.origin, log.origin))
    const launcherFile = join(shared, 'delorun-launcher.tgz')
    await writeFile(launcherFile, await readFile(built.tarball))
    const fixtureFile = await packFixture(fileURLToPath(new URL('fixtures/engines-plugin', import.meta.url)), shared)
    const extraFile = await packFixture(fileURLToPath(new URL('fixtures/extra-bundle', import.meta.url)), shared)
    await writeFile(join(shared, 'answers.json'), `${JSON.stringify({
      schemaVersion: 2,
      modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' } },
      prompts: 'safer',
      background: true,
      profile: { name: null, port: null },
      reach: { option: 'none', identityFactor: null },
      importStockHome: false,
    }, undefined, 2)}\n`)
    const pinned = pins(RELEASE_CACHE)
    const image = await timed('build the machine image', async () => journeyImage(pinned, scratch))
    network = journeyNetwork(image, [channelServer.port, log.port, model.port], shared)
    const machine = await journeyContainer(network, 'person')
    const second = await journeyContainer(network, 'second')
    journey = {
      scratch, shared, trust, base, releases, channel, channelServer, log, model,
      launcherFile: `${SHARED}/delorun-launcher.tgz`, fixtureFile: `${SHARED}/${fixtureFile}`, extraFile: `${SHARED}/${extraFile}`,
      network, machine, second,
      env: {
        HOME: PERSON_HOME,
        PATH: `${PERSON_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
        LANG: 'C.UTF-8',
        DEEPSEEK_API_KEY: 'sk-journey-throwaway',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(model.port)}/v1`,
        BROWSER: `${PERSON_HOME}/.local/bin/xdg-open`,
        npm_config_update_notifier: 'false',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
      },
    }
  }, 3_600_000)

  afterAll(async () => {
    // A person debugging the spec keeps the containers to look inside them; the check never sets this.
    if (process.env['DELORUN_JOURNEY_KEEP'] === '1') process.stdout.write(`journey: kept the containers of network ${network?.name ?? '(none)'}\n`)
    else removeNetwork(network)
    for (const close of closers.reverse()) await close().catch(() => undefined)
    timings.push({ what: 'the whole run', seconds: Math.round((Date.now() - runStarted) / 100) / 10 })
    process.stdout.write(`journey: wall time\n${timings.map(entry => `  ${entry.what}: ${String(entry.seconds)} s`).join('\n')}\n`)
  }, 300_000)

  it('proves its machine reaches only the spec\'s servers', async () => {
    const { channelServer } = parts()
    const reach = (url: string): Promise<Finished> => run(['node', '-e', `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(5000) }).then(r => console.log(r.status), e => { console.log('failed', e.cause?.code ?? e.message); process.exitCode = 1 })`])
    expect((await reach(`http://127.0.0.1:${String(channelServer.port)}/timestamp.json`)).stdout.trim()).toBe('200')
    for (const outside of ['http://192.0.2.1/', 'http://registry.npmjs.org/', `http://host.docker.internal:${String(channelServer.port)}/timestamp.json`]) {
      const answer = await reach(outside)
      expect(answer.stdout, `${outside} must not be reachable from the journey's machine`).toMatch(/^failed /u)
    }
  }, STEP)

  it('step 1: npx installs release 1 with the log agreeing, setup runs, and Delorun starts with the studio answering', async () => {
    const { launcherFile } = parts()
    const first = await run(['npm', 'exec', '--yes', '--offline', `--package=${launcherFile}`, '--', 'delorun', '--version'])
    expect(installChecklist(first)).toEqual([
      `✔ Found release ${R1} on the stable channel`,
      '✔ Signature checked (release root 1)',
      '✔ Release log checked',
      `Downloading ${closureFileNames(R1, 'linux-x64').archive}…`,
      expect.stringMatching(/^✔ Downloaded \d+(\.\d)? (kB|MB)( at \d+(\.\d)? (kB|MB)\/s average)?$/u),
      '✔ Download matches its signed hash',
      'Unpacking the runtime…',
      expect.stringMatching(/^✔ Unpacked the runtime \([\d,]+ files\)$/u),
      `✔ Installed release ${R1}`,
      '✔ Starting Delorun',
    ])
    expect(first.stdout).toMatch(new RegExp(`^Delorun ${R1.replaceAll('.', '\\.')}\\nDSH \\d+\\.\\d+\\.\\d+`, 'u'))
    expect(first.status).toBe(0)
    const record = await readJson<{ releases: Record<string, { state: string }> }>(`${HOME}/trust/release-log.json`)
    expect(record.releases[R1]?.state).toBe('verified')
    // Setup offers to install the command; the journey installs it as that offer does, from the same package.
    const global = await run(['npm', 'install', '--global', '--offline', '--prefix', `${PERSON_HOME}/.local`, launcherFile])
    expect(global.status, global.stderr).toBe(0)
    const setup = await delorun(['setup', '--config', `${SHARED}/answers.json`])
    expect(setup.stderr).toBe('')
    expect(setup.status).toBe(0)
    // The person's computer has a browser; the Host hands it the studio's address with the start token.
    await writeInMachine(`${PERSON_HOME}/.local/bin/xdg-open`, BROWSER_SCRIPT)
    await run(['chmod', '755', `${PERSON_HOME}/.local/bin/xdg-open`])
    const started = await delorun([])
    expect(started.stdout).toContain('Delorun is running · http://127.0.0.1:')
    expect(started.status, started.stderr).toBe(0)
    await waitFor('the studio\'s address in the person\'s browser', async () => (await run(['test', '-s', `${PERSON_HOME}/.journey-browser/opened`])).status === 0)
    expect(await probe('index')).toEqual({ withCookie: 200, html: true, without: 401 })
  }, STEP)

  it('step 1b: every enabled row of the default profile is active', async () => {
    const listed = await rows()
    firstRows = listed
    expect(listed.length).toBeGreaterThan(10)
    expect(listed.map(rowId)).toEqual(expect.arrayContaining(['delorun-privacy', 'delorun-instruction-consent', 'delorun-mcp-consent', 'delorun-permission-defaults', 'delorun-schedule-consent', 'delorun-fetch-guard', 'delorun-chat-states']))
    expect(inactive(listed)).toEqual([])
  }, STEP)

  it('step 1c: a chat against the scripted model completes and is on disk', async () => {
    const { model } = parts()
    chats.first = await chat('Say hello to the journey.')
    expect(model.requests.length).toBeGreaterThan(0)
    expect(await chatFiles(chats.first)).not.toEqual([])
    expect(JSON.stringify(await probe('page', chats.first))).toContain(MODEL_REPLY)
  }, STEP)

  // The address in the home log carries no start token (contract C20 redacts it), so it cannot sign anyone in. What
  // `delorun start`, `delorun status` and setup's ending tell a person without a browser to run is `delorun open --print`.
  it('step 1d: a person without a browser reaches the studio once with the link `delorun open --print` gives', async () => {
    const printed = await delorun(['open', '--print'])
    const link = /(http:\/\/\S+)/u.exec(printed.stdout)?.[1]
    expect(link, printed.stdout.slice(-2000)).toBeDefined()
    expect(await probe('exchange', link!)).toEqual({ status: 303 })
    // The link works once: the probe reports the status without throwing, and a second use is refused as not signed in.
    expect(await probe('exchange', link!)).toEqual({ status: 401 })
  }, STEP)

  it('step 2: with the log silent a fresh install warns and records unchecked; with the log contradicting it refuses and installs nothing', async () => {
    const { log, launcherFile, second } = parts()
    log.mode = 'silent'
    try {
      const silent = await delorun(['--version'], { DELORUN_HOME: `${PERSON_HOME}/silent-home` })
      expect(installChecklist(silent)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^! Release log not checked \(.+\)$/u),
        `  Warning: Release ${R1} has not been checked against the release log; Delorun checks it at the next connection.`,
        `✔ Installed release ${R1}`,
      ]))
      expect(silent.status).toBe(0)
      const record = await readJson<{ releases: Record<string, { state: string }> }>(`${PERSON_HOME}/silent-home/trust/release-log.json`)
      expect(record.releases[R1]?.state).toBe('unchecked')
      log.mode = 'contradict'
      const contradicted = await delorun(['--version'], { DELORUN_HOME: `${PERSON_HOME}/contradicted-home` })
      expect(contradicted.stderr).toContain('because its release-log check failed')
      expect(contradicted.status).toBe(1)
      expect(contradicted.stdout).toBe('')
      expect(await hashes(`${PERSON_HOME}/contradicted-home/runtimes`)).toEqual({})
      expect((await run(['test', '-e', `${PERSON_HOME}/contradicted-home/trust/release-log.json`])).status).not.toBe(0)
    } finally {
      log.mode = 'agree'
    }
    // The second computer, which step 11 imports into, installs and sets up release 1 now, while the channel names it.
    const installed = await run(['npm', 'exec', '--yes', '--offline', `--package=${launcherFile}`, '--', 'delorun', 'setup', '--config', `${SHARED}/answers.json`], {}, second)
    expect(installed.status, installed.stderr).toBe(0)
    const global = await run(['npm', 'install', '--global', '--offline', '--prefix', `${PERSON_HOME}/.local`, launcherFile], {}, second)
    expect(global.status, global.stderr).toBe(0)
  }, STEP)

  it('step 3a: delorun plugin adds a plugin from a file on a computer that has only Delorun', async () => {
    const { fixtureFile } = parts()
    const added = await delorun(['plugin', '--profile', 'default', 'add', `file:${fixtureFile}`])
    expect(added.status, `${added.stdout}\n${added.stderr}`).toBe(0)
  }, STEP)

  it('step 3: the profile is customised and every customisation loads', async () => {
    const { fixtureFile, extraFile } = parts()
    expect((await delorun(['stop'])).status).toBe(0)
    // The machine has no pnpm: `delorun plugin` runs the one the release carries.
    expect((await run(['sh', '-c', 'command -v pnpm'])).status).not.toBe(0)
    // Two plugins from files: the fixture whose engines range excludes release 2, and a bundle the person turns off again.
    for (const file of [fixtureFile, extraFile]) {
      // Upstream's `dsh plugin`, which `delorun plugin` runs unchanged, takes the profile by name.
      const added = await delorun(['plugin', '--profile', 'default', 'add', `file:${file}`])
      expect(added.status, `${added.stdout}\n${added.stderr}`).toBe(0)
    }
    const manifest = await readJson<{ dsh: { profile: { bundles: string[] } } }>(`${PROFILE}/package.json`)
    expect(manifest.dsh.profile.bundles).toContain(EXTRA)
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(bundle => bundle !== EXTRA)
    await writeInMachine(`${PROFILE}/package.json`, `${JSON.stringify(manifest, undefined, 2)}\n`)
    customised.removedBundle = EXTRA
    // The person turns off one of the shipped presets.
    customised.disabledRow = 'preset-cordis'
    expect(firstRows.find(row => rowId(row) === customised.disabledRow)?.fiberPhase, 'the default profile has no active preset-cordis row to turn off').toBe('active')
    customised.presetId = 'journey'
    const patch = (await run(['cat', `${PROFILE}/cordis.patch.yml`])).stdout
    await writeInMachine(`${PROFILE}/cordis.patch.yml`, [
      patch.trimEnd(),
      '',
      '# The person turned a row off.',
      `- id: ${customised.disabledRow!}`,
      '  disabled: true',
      '',
      '# The person\'s look: the Ocean palette.',
      '- id: delorun-theme',
      '  config:',
      '    studioAdditions: true',
      '    palette: ocean',
      '',
      '# The person\'s own preset.',
      '- insert:',
      '    - id: preset-journey',
      '      name: \'@deepseek-ai/dsh-agent-preset\'',
      '      config:',
      `        id: ${customised.presetId}`,
      '        plugins: []',
      '',
    ].join('\n'))
    await run(['mkdir', '-p', `${HOME}/skills/journey-notes`])
    await writeInMachine(`${HOME}/skills/journey-notes/SKILL.md`, '---\nname: journey-notes\ndescription: Notes the journey keeps about the release it tests.\n---\n\nKeep notes short.\n')
    const started = await delorun(['start'])
    expect(started.status, `${started.stdout}\n${started.stderr}`).toBe(0)
    const listed = await rows()
    expect(inactive(listed)).toEqual([])
    expect(listed.find(row => rowId(row) === 'journey-engines-fixture')?.fiberPhase).toBe('active')
    expect(listed.map(rowId)).not.toContain('journey-extra-fixture')
    expect(listed.find(row => rowId(row) === customised.disabledRow)?.enabled).toBe(false)
    expect(listed.find(row => rowId(row) === 'preset-journey')?.fiberPhase).toBe('active')
    expect(listed.find(row => rowId(row) === 'delorun-theme')?.fiberPhase).toBe('active')
    customised.files = await customisations()
  }, STEP)

  it('step 4a: delorun update stops before it fetches anything when git cannot run, and says what to install; the update check needs no git', async () => {
    await ensureRunning()
    const before = await stats(`${HOME}/runtimes`)
    // The person's PATH without the system directories, where Debian puts git; the launcher and its Node stay on it.
    const noGit = { PATH: `${PERSON_HOME}/.local/bin:/usr/local/bin` }
    const refused = await delorun(['update', '--report'], noGit)
    expect(refused.stderr).toContain('git cannot run here: no git command is on PATH. Install git, then run delorun update again. Nothing was fetched or changed.')
    expect(refused.status).toBe(1)
    // The update check reads the channel's signed files and changes nothing, so it runs without git.
    const checked = await delorun(['update', '--check'], noGit)
    expect(checked.stdout, checked.stderr).toBe(`✓ Up to date · ${R1} (newest on the stable channel)\n`)
    expect(checked.status).toBe(0)
    expect(await stats(`${HOME}/runtimes`)).toEqual(before)
  }, STEP)

  it('step 4: delorun update to release 2 prints the report naming the fixture plugin before anything changes, and after confirming the health check passes with every customisation present', async () => {
    await ensureRunning()
    const { trust, log, channel, releases } = parts()
    const closures = await releases
    await publish(trust, log, channel, R2, closures[R2]!)
    const before = { ...await hashes(PROFILE), ...await stats(`${HOME}/runtimes`) }
    const refused = await delorun(['update', '--yes'])
    expect(refused.stderr).toContain('--yes does not confirm it')
    expect(refused.status).toBe(1)
    let atPrompt: Record<string, string> = {}
    const updated = await interact(parts().machine, 'delorun update', parts().env, [{
      when: new RegExp(`Apply the update to Delorun ${R2.replaceAll('.', '\\.')}`, 'u'),
      before: async () => { atPrompt = { ...await hashes(PROFILE), ...await stats(`${HOME}/runtimes`) } },
      send: 'y',
    }])
    expect(updated.stdout).toContain(`${FIXTURE} requires Delorun >=0.1.0 <0.2.0; the update installs Delorun ${R2}.`)
    // Before the confirmation the staged target is in the store (C3), and nothing that was there changed.
    for (const [path, digest] of Object.entries(before)) expect(atPrompt[path], `${path} changed before the person confirmed`).toBe(digest)
    expect(updated.stdout).toContain(`Delorun ${R2} runs now.`)
    expect(updated.status).toBe(0)
    expect(await running()).toBe(R2)
    const listed = await rows()
    expect(inactive(listed).filter(line => !line.startsWith('journey-engines-fixture '))).toEqual([])
    expect(await customisations()).toEqual(customised.files)
  }, STEP)

  it('step 5: delorun recover rollback returns to release 1 with the customisations and the chat, and release 1 reads every record release 2 wrote', async () => {
    const rolled = await delorun(['recover', 'rollback'])
    expect(rolled.stdout).toContain('Rolled back.')
    expect(rolled.status, rolled.stderr).toBe(0)
    expect(await running()).toBe(R1)
    expect(await customisations()).toEqual(customised.files)
    expect(inactive(await rows())).toEqual([])
    expect(await chatFiles(chats.first!)).not.toEqual([])
    const status = await delorun(['recover', 'status'])
    expect(status.stderr).toBe('')
    expect(status.status).toBe(0)
    expect(status.stdout).toContain(R2)
  }, STEP)

  it('step 6: an update to release 2b, whose Host never becomes ready, rolls back automatically and names the failed criterion', async () => {
    await ensureRunning()
    const { trust, log, channel, releases, machine, env } = parts()
    const closures = await releases
    await publish(trust, log, channel, R2B, closures[R2B]!)
    const updated = await interact(machine, 'delorun update', env, [{ when: new RegExp(`Apply the update to Delorun ${R2B.replaceAll('.', '\\.')}`, 'u'), send: 'y' }])
    const named = new RegExp(`Delorun ${R2B.replaceAll('.', '\\.')} failed its health check \\(H2-host-ready`, 'u')
    // A rollback that did not finish leaves the home process's log as the only record of why.
    expect(updated.stdout, named.test(updated.stdout) ? '' : `${(await delorun(['logs', 'home'])).stdout}\n${await lockProbe()}`).toMatch(named)
    expect(updated.status).toBe(1)
    expect(await running()).toBe(R1)
    expect(inactive(await rows())).toEqual([])
  }, STEP)

  it('step 7: an update to release 3 names the data change and takes the copy; the rollback restores the first chat and sets the second aside', async () => {
    await ensureRunning()
    const { trust, log, channel, releases, machine, env } = parts()
    const closures = await releases
    await publish(trust, log, channel, R3, closures[R3]!)
    const updated = await interact(machine, 'delorun update', env, [
      { when: new RegExp(`Apply the update to Delorun ${R3.replaceAll('.', '\\.')}`, 'u'), send: 'y' },
      { when: /Take a copy first\?/u, send: '\r' },
    ])
    expect(updated.stdout).toContain(`Chat data: Delorun ${R3} keeps chat data in a format Delorun ${R1} may not read.`)
    expect(updated.stdout).toContain(`Delorun ${R3} runs now. The chat data from before is copied in data-copies/${R3}.`)
    expect(updated.status).toBe(0)
    expect(await running()).toBe(R3)
    // Release 3 migrated the chat-states unit, which release 1 refuses to read.
    expect(await chatStatesUnitVersion()).toBe(2)
    chats.second = await chat('Say hello to the journey again, under release 3.')
    const rolled = await delorun(['recover', 'rollback'])
    expect(rolled.stdout).toMatch(/set aside/u)
    expect(rolled.status, rolled.stderr).toBe(0)
    expect(await running()).toBe(R1)
    expect(await chatStatesUnitVersion()).not.toBe(2)
    expect(inactive(await rows())).toEqual([])
    expect(await chatFiles(chats.first!)).not.toEqual([])
    expect(await chatFiles(chats.second)).toEqual([])
    expect(await chatFiles(chats.second, `${HOME}/data-set-aside`)).not.toEqual([])
  }, STEP)

  it('step 8: the same update without the copy cannot roll back the data, and --profile-only goes back on the profile alone', async () => {
    await ensureRunning()
    const { machine, env } = parts()
    const before = await customisations()
    const updated = await interact(machine, 'delorun update --no-data-copy', env, [{ when: new RegExp(`Apply the update to Delorun ${R3.replaceAll('.', '\\.')}`, 'u'), send: 'y' }])
    expect(updated.stdout).toContain('Continuing without the copy.')
    expect(updated.status).toBe(0)
    expect(await running()).toBe(R3)
    const refused = await delorun(['recover', 'rollback'])
    expect(refused.stderr).toContain('ROLLBACK_NEEDS_DATA_COPY')
    expect(refused.status).toBe(1)
    const profileOnly = await delorun(['recover', 'rollback', '--profile-only'])
    expect(profileOnly.status, profileOnly.stderr).toBe(0)
    expect(await running()).toBe(R3)
    expect(await customisations()).toEqual(before)
  }, STEP)

  it('step 9a: a fresh install of a release with one changed byte inside a file of its archive is refused, and nothing is installed', async () => {
    const { trust, log, channel, releases } = parts()
    const closures = await releases
    await publish(trust, log, channel, R4, closures[R4]!)
    const refused = await delorun(['--version'], { DELORUN_HOME: `${PERSON_HOME}/tampered-home` })
    expect(refused.stderr).toMatch(/data-formats\.json|did not verify|refused/u)
    expect(refused.status).toBe(1)
    expect(await hashes(`${PERSON_HOME}/tampered-home/runtimes`)).toEqual({})
  }, STEP)

  it('step 9b: an update to that release is refused before installation, with runtimes/ unchanged; the update check names it, as it reads no archive', async () => {
    await ensureRunning()
    const before = await stats(`${HOME}/runtimes`)
    // The channel's signed metadata is intact; only a file inside the archive changed, which the check never downloads.
    const checked = await delorun(['update', '--check'])
    expect(checked.stdout, checked.stderr).toContain(`Delorun ${R4} is available`)
    expect(checked.status).toBe(0)
    for (const args of [['update', '--report'], ['update', '--yes']]) {
      const refused = await delorun(args)
      expect(`${refused.stdout}\n${refused.stderr}`).toMatch(/data-formats\.json|did not verify|INSTALL_VERIFY_FAILED/u)
      expect(refused.status).toBe(1)
    }
    expect(await stats(`${HOME}/runtimes`)).toEqual(before)
  }, STEP)

  it('step 10: delorun verify passes on the installed release and names a runtime file that was changed', async () => {
    const verified = await delorun(['verify'])
    expect(verified.stdout).toMatch(/^passed +runtime-files +all \d+ files of runtime \S+ match the signed file list$/mu)
    expect(verified.status, `${verified.stdout}\n${verified.stderr}`).toBe(0)
    const current = `${HOME}/runtimes/${(await running()) ?? R1}`
    const file = `${current}/data-formats.json`
    const original = (await run(['cat', file])).stdout
    await run(['chmod', 'u+w', current, file])
    await writeInMachine(file, `${original.trimEnd()} \n`)
    try {
      const failed = await delorun(['verify'])
      expect(`${failed.stdout}\n${failed.stderr}`).toContain('data-formats.json')
      expect(failed.status).not.toBe(0)
    } finally {
      await writeInMachine(file, original)
      await run(['chmod', 'a-w', file, current])
    }
  }, STEP)

  it('step 11: a chat goes to the trash and comes back, and its signed export imports into a second fresh home', async () => {
    await ensureRunning()
    const { second } = parts()
    const first = chats.first!
    const trashed = { value: await probe<{ id: string }>('trash', first) }
    expect((await delorun(['stop'])).status).toBe(0)
    const listed = await delorun(['trash', 'list', '--json'])
    expect(listed.stdout).toContain(trashed.value!.id)
    const restored = await delorun(['trash', 'restore', trashed.value!.id])
    expect(restored.status, `${restored.stdout}\n${restored.stderr}`).toBe(0)
    expect(await chatFiles(first)).not.toEqual([])
    const exported = await interact(parts().machine, `delorun export ${first} --out ${PERSON_HOME}/first-chat.delorun`, parts().env, [{ when: /\[y\/N\]/u, send: 'y\r' }])
    expect(exported.status, exported.stdout).toBe(0)
    const archive = join(parts().scratch, 'first-chat.delorun')
    execFileSync('docker', ['cp', `${parts().machine}:${PERSON_HOME}/first-chat.delorun`, archive], { timeout: 60_000 })
    execFileSync('docker', ['cp', archive, `${second}:/tmp/first-chat.delorun`], { timeout: 60_000 })
    // Without a terminal nothing is asked and nothing is imported; the preview names the signer's fingerprint in groups.
    const unasked = await delorun(['import', '/tmp/first-chat.delorun'], {}, second)
    expect(unasked.status).not.toBe(0)
    // The signer's fingerprint is printed in groups of four; a person types it as shown.
    const fingerprint = /Unverified signer · ([0-9a-zA-Z:+/=_ -]{16,})\n/u.exec(`${unasked.stdout}\n${unasked.stderr}`)?.[1]
    expect(fingerprint, unasked.stdout).toBeDefined()
    const imported = await interact(second, 'delorun import /tmp/first-chat.delorun', parts().env, [
      { when: /type the key fingerprint/u, send: `${fingerprint!}\r` },
      { when: /\[y\/N\]/u, send: 'y\r' },
    ])
    expect(imported.status, imported.stdout).toBe(0)
    expect(await chatFiles(first, `${HOME}/archive/imported`, second)).not.toEqual([])
  }, STEP)
})

/**
 * Wait until something holds, for at most two minutes.
 * @param what - what is waited for, for the failure.
 * @param holds - whether it holds now.
 */
async function waitFor(what: string, holds: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 120_000
  while (!await holds()) {
    if (Date.now() > deadline) throw new Error(`waited two minutes for ${what}`)
    await new Promise(done => setTimeout(done, 500))
  }
}

/**
 * Write a file in the person's computer, as the person's editor would.
 * @param path - the file.
 * @param content - its new content.
 */
async function writeInMachine(path: string, content: string): Promise<void> {
  const written = await run(['node', '-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', path, content])
  if (written.status !== 0) throw new Error(`${path} could not be written: ${written.stderr}`)
}

/** The version stamped on the chat-states storage unit under the home's `storages/`, or `undefined` without one. */
async function chatStatesUnitVersion(): Promise<number | undefined> {
  const answer = await run(['node', `${MOUNT}/home.mjs`, 'unit', `${HOME}/storages`, 'delorun_chat_states'])
  return json<number | null>(answer) ?? undefined
}
