/**
 * The home process as the Docker supervisor's launcher (contract C19, start step 6; C9, "The Docker supervisor"):
 * it spawns `@delo/supervisor`'s entry module as a separate process of the person's user with a pipe on file
 * descriptor 3 and writes one launch line carrying this start's token, so the token never appears in a command
 * line or an environment variable. The pipe stays open while the start runs; ending it stops the supervisor, and a
 * home process that dies closes it too.
 *
 * @module @delo/home-process/supervisor-launch
 */
import { spawn } from 'node:child_process'
import type { Writable } from 'node:stream'
import type { StartToken } from '@delo/contract-home-layout'
import type { LogLevel } from '@delo/contract-operational-logs'
import type { DeloLogger } from '@delo/logs'
import { encodeLaunch, LAUNCH_FD, type ImagePull, type SupervisorTiming, type VerifiedManifest } from '@delo/supervisor'
import type { HomeCommand } from './seams.ts'

/** What a machine set up for Docker supplies to launch its supervisor. */
export interface SupervisorSetup {
  /** The command that runs `@delo/supervisor`'s entry module from the running runtime. */
  readonly command: HomeCommand
  /** The verified release manifest's image entries of the running runtime. */
  readonly manifest: VerifiedManifest
  /** Whether absent listed images are pulled from the registry. */
  readonly imagePull: ImagePull
  /** The absolute directory holding the seccomp profile files the manifest lists. */
  readonly seccompDirectory: string
  /** The most detailed level the supervisor logs. */
  readonly logLevel: LogLevel
  /** The supervisor's deadlines. */
  readonly timing: SupervisorTiming
}

/** This start's values the launch line carries. */
export interface SupervisorStart {
  /** The resolved Delo home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** C1's start id of this start. */
  readonly startId: string
  /** This start's token. */
  readonly token: StartToken
}

/** A supervisor this home process launched. */
export interface LaunchedSupervisor {
  /** Its process id. */
  readonly pid: number
  /**
   * End the launch pipe and wait for the supervisor to exit.
   * @returns when it has exited.
   */
  stop(): Promise<void>
}

/**
 * Launch the supervisor.
 * @param setup - the command and the values of the running runtime.
 * @param start - this start's home, profile, start id and token.
 * @param logger - the home process's logger, which records an unexpected exit.
 * @returns the launched supervisor.
 */
export function launchSupervisor(setup: SupervisorSetup, start: SupervisorStart, logger: DeloLogger): LaunchedSupervisor {
  const child = spawn(setup.command.command, [...setup.command.args], { cwd: setup.command.cwd, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })
  const pipe = child.stdio[LAUNCH_FD] as Writable
  let stopping = false
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      if (!stopping) logger.warn('the supervisor exited', { data: { code: code ?? -1, signal: signal ?? '' } })
      resolve()
    })
    child.once('error', (error) => {
      logger.error('the supervisor could not be started', { err: error })
      resolve()
    })
  })
  pipe.on('error', (error: NodeJS.ErrnoException) => {
    // EPIPE when the supervisor has exited; its exit is logged above.
    logger.debug('the supervisor launch pipe failed', { data: { code: error.code ?? 'unknown' } })
  })
  pipe.write(encodeLaunch({
    v: 1, home: start.home, profile: start.profile, startId: start.startId, token: start.token, manifest: setup.manifest,
    imagePull: setup.imagePull, seccompDirectory: setup.seccompDirectory, logLevel: setup.logLevel, timing: setup.timing,
  }))
  return {
    pid: child.pid ?? -1,
    async stop() {
      stopping = true
      pipe.end()
      await exited
    },
  }
}
