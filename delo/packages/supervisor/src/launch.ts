/**
 * How the home process starts the supervisor (contract C9, "The Docker supervisor"): it spawns the supervisor's
 * entry module as a separate process of the person's user and writes one launch line to the inherited pipe on file
 * descriptor 3, which carries the start token, so the token never appears in a command line or an environment
 * variable. The pipe stays open for the life of the home-process start; when it closes, because the home process
 * stopped or died, the supervisor closes its socket and exits, and the next start launches a new supervisor with
 * the new token.
 *
 * @module @delo/supervisor/launch
 */
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { Socket } from 'node:net'
import type { LogLevel } from '@delo/contract-operational-logs'
import { START_TOKEN_LENGTH, type StartToken } from '@delo/contract-home-layout'
import { z } from 'zod'
import { captureSupervisorOutput, openSupervisorLog } from './log.ts'
import { verifiedManifestSchema, type VerifiedManifest } from './manifest.ts'
import { Supervisor } from './supervisor.ts'
import type { ImagePull } from './images.ts'

/** The inherited file descriptor that carries the launch line and stays open while the home-process start runs. */
export const LAUNCH_FD = 3

/** The largest launch line, in bytes. */
export const LAUNCH_MAX_BYTES = 1_048_576

/** What the home process sends at launch. */
export interface SupervisorLaunch {
  /** Launch-line version. */
  readonly v: 1
  /** The resolved Delo home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** C1's start id of this home-process start; not a secret. */
  readonly startId: string
  /** The start token this start wrote to `run/<profile>/start-token`. */
  readonly token: StartToken
  /** The verified release manifest's image entries. */
  readonly manifest: VerifiedManifest
  /** Whether absent listed images are pulled from the registry. */
  readonly imagePull: ImagePull
  /** The absolute directory holding the seccomp profile files the manifest lists, from the running runtime's release. */
  readonly seccompDirectory: string
  /** The most detailed level the supervisor logs. */
  readonly logLevel: LogLevel
}

const launchSchema = z.strictObject({
  v: z.literal(1),
  home: z.string().min(1),
  profile: z.string().min(1),
  startId: z.string().regex(/^[0-9a-f]{32}$/),
  token: z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${String(START_TOKEN_LENGTH)}}$`)),
  manifest: verifiedManifestSchema,
  imagePull: z.enum(['registry', 'none']),
  seccompDirectory: z.string().refine(isAbsolute, { message: 'an absolute path' }),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']),
})

/**
 * Encode a launch line, for the home process.
 * @param launch - the launch values.
 * @returns the line, with its newline.
 */
export function encodeLaunch(launch: SupervisorLaunch): string {
  return `${JSON.stringify(launch)}\n`
}

/**
 * Check a launch line.
 * @param line - the line, without its newline.
 * @returns the launch values.
 * @throws {Error} naming the first problem, never a value.
 */
export function parseLaunch(line: string): SupervisorLaunch {
  const parsed = launchSchema.safeParse(JSON.parse(line))
  if (!parsed.success) throw new Error(`the supervisor's launch line is not valid at ${parsed.error.issues[0]?.path.join('.') ?? 'its root'}`)
  // The schema checked the token's form and the manifest's digests; the brands are the contracts' own types.
  return parsed.data as SupervisorLaunch
}

/**
 * Read the launch line from the inherited pipe.
 * @param pipe - the pipe on {@link LAUNCH_FD}.
 * @returns the line.
 * @throws {Error} when the pipe ends first or the line exceeds {@link LAUNCH_MAX_BYTES}.
 */
function readLaunchLine(pipe: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const newline = buffered.indexOf(0x0a)
      if (newline === -1 && buffered.length <= LAUNCH_MAX_BYTES) return
      pipe.off('data', onData)
      pipe.off('end', onEnd)
      if (newline === -1 || newline > LAUNCH_MAX_BYTES) reject(new Error(`the launch line exceeds ${String(LAUNCH_MAX_BYTES)} bytes`))
      else resolve(buffered.subarray(0, newline).toString('utf8'))
    }
    const onEnd = (): void => { reject(new Error('the launch pipe closed before the launch line')) }
    pipe.on('data', onData)
    pipe.once('end', onEnd)
  })
}

/**
 * Run the supervisor process: read the launch line, open the log, register the token with its redactor, capture the
 * process's output, start the supervisor and stop it when the launch pipe closes or a termination signal arrives.
 * @returns when the supervisor has stopped; the process's exit code is set.
 */
export async function runSupervisorProcess(): Promise<void> {
  const pipe = new Socket({ fd: LAUNCH_FD, readable: true, writable: false })
  const launch = parseLaunch(await readLaunchLine(pipe))
  let failures = 0
  const { log, redactor, logger } = openSupervisorLog({ home: launch.home, profile: launch.profile, startId: launch.startId, level: launch.logLevel, onFailure: () => { failures += 1 } })
  redactor.register(launch.token, 'start-token')
  const restore = captureSupervisorOutput(log)
  let supervisor: Supervisor | undefined
  try {
    supervisor = await Supervisor.start({ home: launch.home, profile: launch.profile, token: launch.token, manifest: launch.manifest, pull: launch.imagePull, logger, env: process.env, osHome: homedir(), seccompDirectory: launch.seccompDirectory })
  } catch (error) {
    logger.error('the supervisor could not start', { err: error })
    restore()
    log.close()
    pipe.destroy()
    process.exitCode = 1
    return
  }
  await new Promise<void>((resolve) => {
    const stop = (reason: string): void => {
      logger.info('stopping', { data: { reason } })
      resolve()
    }
    pipe.once('end', () => { stop('the home process closed the launch pipe') })
    pipe.once('close', () => { stop('the launch pipe closed') })
    process.once('SIGTERM', () => { stop('SIGTERM') })
    process.once('SIGINT', () => { stop('SIGINT') })
    pipe.resume()
  })
  await supervisor.close()
  logger.info('stopped', { data: { logFailures: failures } })
  restore()
  log.close()
  pipe.destroy()
}
