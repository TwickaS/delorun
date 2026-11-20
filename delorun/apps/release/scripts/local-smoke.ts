/**
 * The installed smoke against closures built on this computer: signs two releases from closure directories that
 * `build-closure.ts` wrote, the previous one and the candidate, with throwaway keys and a stand-in release log
 * ({@link trust}), into a new channel directory, then runs the installed smoke of `installed-smoke.ts` on that channel,
 * so its step 6 updates the previous release to the candidate through the real updater. Nothing here signs with a
 * production key; the keys live in the run's directory and are removed with it unless `--keep` is given.
 *
 * `tsx delorun/apps/release/scripts/local-smoke.ts --previous-closure <dir> --previous-version <v> --closure <dir> --version <v>
 * [--work <dir>] [--channel-port <n>] [--studio-port <n>] [--budget-minutes <n>] [--log <file>] [--keep]`
 *
 * Each closure directory holds `delorun-<version>-linux-x64.tar.gz`, its `.files.json`, and the packs file and pack
 * archives, as a `build-closure.ts --version <v> --platform linux-x64` run leaves them.
 *
 * @module local-smoke
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { repositoryRoot } from '@delorun/tools/src/git.ts'
import { keyFile, serveLog, trust } from '../tests/local/support.ts'
import { runSmoke } from './installed-smoke.ts'

/** What the command needs. */
export interface LocalSmokeRequest {
  /** The closure directory of the release the update leaves. */
  readonly previousClosure: string
  /** That release's version. */
  readonly previousVersion: string
  /** The closure directory of the candidate. */
  readonly closure: string
  /** The candidate's version. */
  readonly version: string
  /** The run's directory; a new one under `/var/tmp` when omitted. */
  readonly work: string | undefined
  /** The port the channel is served on. */
  readonly channelPort: number
  /** The studio's port. */
  readonly studioPort: number
  /** The smoke's time budget in minutes. */
  readonly budgetMinutes: number
  /** The smoke's log file. */
  readonly log: string | undefined
  /** Keep the run's directory, throwaway keys included. */
  readonly keep: boolean
}

/**
 * Parse the command line.
 * @param argv - the arguments after the script.
 * @returns the request.
 * @throws Error naming the first wrong or missing flag.
 */
export function parseLocalSmokeArgs(argv: readonly string[]): LocalSmokeRequest {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      'previous-closure': { type: 'string' },
      'previous-version': { type: 'string' },
      'closure': { type: 'string' },
      'version': { type: 'string' },
      'work': { type: 'string' },
      'channel-port': { type: 'string', default: '18981' },
      'studio-port': { type: 'string', default: '18982' },
      'budget-minutes': { type: 'string', default: '40' },
      'log': { type: 'string' },
      'keep': { type: 'boolean', default: false },
    },
  })
  const required = (name: 'previous-closure' | 'previous-version' | 'closure' | 'version'): string => {
    const value = values[name]
    if (value === undefined || value === '') throw new Error(`pass --${name}`)
    return value
  }
  const number = (name: 'channel-port' | 'studio-port' | 'budget-minutes'): number => {
    const value = Number(values[name])
    if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} is a whole number, not ${values[name]!}`)
    return value
  }
  return {
    previousClosure: resolve(required('previous-closure')),
    previousVersion: required('previous-version'),
    closure: resolve(required('closure')),
    version: required('version'),
    work: values.work === undefined ? undefined : resolve(values.work),
    channelPort: number('channel-port'),
    studioPort: number('studio-port'),
    budgetMinutes: number('budget-minutes'),
    log: values.log === undefined ? undefined : resolve(values.log),
    keep: values.keep,
  }
}

/**
 * Run a command to its end with its output on this process's.
 * @param executable - the program.
 * @param args - its arguments.
 * @param cwd - its working directory.
 * @throws Error when it exits with a status other than 0.
 */
async function signed(executable: string, args: readonly string[], cwd: string): Promise<void> {
  const status = await new Promise<number | null>((settle, fail) => {
    const child = spawn(executable, [...args], { cwd, stdio: 'inherit' })
    child.on('error', fail)
    child.on('close', settle)
  })
  if (status !== 0) throw new Error(`${executable} ${args.slice(0, 2).join(' ')} exited ${String(status)}`)
}

/**
 * Sign the two releases into a new channel and run the installed smoke on it.
 * @param request - the request.
 * @param say - prints one line.
 * @returns the smoke's exit code.
 */
export async function runLocalSmoke(request: LocalSmokeRequest, say: (line: string) => void): Promise<0 | 1> {
  const repository = repositoryRoot(process.cwd())
  const work = request.work ?? mkdtempSync(join('/var/tmp', 'local-smoke-'))
  mkdirSync(work, { recursive: true, mode: 0o700 })
  const cleanups: (() => void | Promise<void>)[] = []
  try {
    const trusted = trust()
    const log = await serveLog({ onTestFinished: fn => void cleanups.push(fn) }, trusted)
    const keys = join(work, 'keys')
    mkdirSync(keys, { mode: 0o700 })
    const targets = keyFile(keys, 'targets.pem', trusted.keys.targets)
    const timestamp = keyFile(keys, 'timestamp.pem', trusted.keys.timestamp)
    const root = join(work, '1.root.json')
    writeFileSync(root, trusted.root)
    const channel = join(work, 'channel')
    const state = join(work, 'timestamp-state.json')
    // The previous release is only the update's starting point, and a published one may carry its builder's paths; the candidate is refused if it does.
    for (const [version, closure, starting] of [[request.previousVersion, request.previousClosure, true], [request.version, request.closure, false]] as const) {
      say(`local smoke: signing ${version} from ${closure}`)
      // The stand-in log runs in this process, so the signing command must not block its event loop.
      await signed(join(repository, 'node_modules/.bin/tsx'), [
        'delorun/apps/release/src/local-release.ts', '--version', version, '--summary', `local smoke ${version}`,
        '--out', channel, '--root', root, '--targets-key', targets, '--timestamp-key', timestamp, '--state', state,
        '--log-submit', log.endpoints.submit, '--log-checkpoint', log.endpoints.checkpoint, '--log-tiles', log.endpoints.tiles,
        '--log-poll-seconds', '1', '--closures-from', closure,
        ...starting ? ['--allow-builder-paths'] : [],
      ], repository)
    }
    return await runSmoke({
      channel,
      version: request.version,
      launcher: undefined,
      channelPort: request.channelPort,
      studioPort: request.studioPort,
      budgetMinutes: request.budgetMinutes,
      log: request.log ?? join(work, 'installed-smoke.log'),
      keepGoing: false,
      keepHome: request.keep,
      logOrigin: log.origin,
      previous: undefined,
      keys,
    }, say)
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup()
    if (request.keep) say(`local smoke: kept ${work}`)
    else rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Run the command.
 * @param argv - the arguments after the script.
 * @returns the exit code: 0 when the smoke passed, 1 when it failed, 2 for a wrong command line.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let request: LocalSmokeRequest
  try {
    request = parseLocalSmokeArgs(argv)
  } catch (error) {
    console.error(`local smoke: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  return runLocalSmoke(request, line => console.log(line))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
