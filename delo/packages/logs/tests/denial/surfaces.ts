/**
 * The surfaces C20 lists, for the cross-surface denial suite: which package writes each, whether that package is in
 * the tree and writes through `@delo/logs`, and the driver that runs it under the suite. A surface whose package
 * depends on `@delo/logs` must register a driver here, or the suite fails.
 *
 * The suite also runs the reference surface: `@delo/logs` itself, writing the `home-default` surface and capturing a
 * child process's output, which is the path every surface's records take.
 */
import type { SecretKind, SurfaceKind } from '@delo/contract-operational-logs'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUPERVISOR_DRIVER } from '../../../supervisor/tests/log-driver.ts'
import { captureStream, LineCapture, Redactor, resolveSurface, SurfaceLog, type CapturedStream, type DeloLogDetails, type LogsFailure, type SurfaceLocation } from '../../src/index.ts'

/** The repository root. */
export const REPOSITORY = fileURLToPath(new URL('../../../../../', import.meta.url))

/** One surface started under the suite. */
export interface RunningSurface {
  /** The surface's log files. */
  readonly location: SurfaceLocation
  /** Failures the surface's writer reported. */
  readonly failures: readonly LogsFailure[]
  /** Hold a secret value as the surface holds what it loads, registered with its redactor. */
  register(value: string, kind: SecretKind): void
  /** Write one of Delo's own records through the surface's logger. */
  log(message: string, details?: DeloLogDetails): Promise<void>
  /** Make upstream code the surface runs print to one stream, in exactly these writes. */
  print(stream: CapturedStream, writes: readonly string[]): Promise<void>
  /** Stop the surface. */
  stop(): Promise<void>
}

/** Starts one surface in a Delo home. */
export interface SurfaceDriver {
  /**
   * @param home - an empty Delo home.
   * @returns the running surface.
   */
  start(home: string): Promise<RunningSurface>
}

/** A surface C20 lists. */
export interface SurfaceEntry {
  /** C20's surface name. */
  readonly name: string
  readonly kind: SurfaceKind
  /** The repository-relative directory of the package that writes the surface. */
  readonly owner: string
  /** The work package that wires the surface to `@delo/logs`. */
  readonly workPackage: string
  /** The surface's driver, once its package writes through `@delo/logs`. */
  readonly driver?: SurfaceDriver
}

/** Every surface C20 lists. */
export const SURFACES: readonly SurfaceEntry[] = [
  { name: 'home-<profile>', kind: 'home', owner: 'delo/packages/home-process', workPackage: 'WP3.9' },
  { name: 'supervisor-<profile>', kind: 'supervisor', owner: 'delo/packages/supervisor', workPackage: 'WP4.1', driver: SUPERVISOR_DRIVER },
  { name: 'desktop-host', kind: 'desktop-host', owner: 'apps/desktop', workPackage: 'WP6.1' },
  { name: 'relay', kind: 'relay', owner: 'delo/apps/relay', workPackage: 'WP5.6' },
]

/** Whether a surface's package is in the tree and writes through `@delo/logs`. */
export type SurfaceState =
  | { readonly kind: 'absent'; readonly reason: string }
  | { readonly kind: 'not-wired'; readonly reason: string }
  | { readonly kind: 'wired' }

/**
 * Where a surface stands in this tree.
 * @param entry - the surface.
 * @returns absent, present but not writing through `@delo/logs`, or wired.
 */
export function surfaceState(entry: SurfaceEntry): SurfaceState {
  const manifest = join(REPOSITORY, entry.owner, 'package.json')
  if (!existsSync(manifest)) return { kind: 'absent', reason: `${entry.owner} is not in the tree (${entry.workPackage})` }
  const fields = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, Record<string, string> | undefined>
  const wired = ['dependencies', 'devDependencies', 'peerDependencies'].some(section => fields[section]?.['@delo/logs'] !== undefined)
  return wired ? { kind: 'wired' } : { kind: 'not-wired', reason: `${entry.owner} does not write through @delo/logs yet (${entry.workPackage})` }
}

/** A child process that prints its standard input's writes, each in its own write call, to one stream. */
const PRINTER = `
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', async () => {
  const { stream, writes } = JSON.parse(input)
  for (const text of writes) {
    await new Promise(resolve => process[stream].write(text, resolve))
    await new Promise(resolve => setTimeout(resolve, 5))
  }
})
`

/** The reference surface: `@delo/logs` writing `home-default` and capturing a child process's output. */
export const REFERENCE_DRIVER: SurfaceDriver = {
  start: (home) => {
    const redactor = new Redactor()
    const failures: LogsFailure[] = []
    const log = SurfaceLog.open({
      location: resolveSurface({ kind: 'home', home, profile: 'default' }),
      redactor,
      pid: process.pid,
      level: 'debug',
      onFailure: (error) => { failures.push(error) },
      now: Date.now,
    })
    const logger = log.logger('delo-denial')
    return Promise.resolve({
      location: log.location,
      failures,
      register: (value, kind) => { redactor.register(value, kind) },
      log: (message, details) => {
        logger.info(message, details)
        return Promise.resolve()
      },
      print: async (stream, writes) => {
        const child = spawn(process.execPath, ['-e', PRINTER], { stdio: ['pipe', 'pipe', 'pipe'] })
        const stops = [captureStream(child.stdout, new LineCapture(log, 'stdout', 'info')), captureStream(child.stderr, new LineCapture(log, 'stderr', 'warn'))]
        const closed = new Promise(resolve => child.on('close', resolve))
        child.stdin.end(JSON.stringify({ stream, writes }))
        await closed
        for (const stop of stops) stop()
      },
      stop: () => {
        log.close()
        return Promise.resolve()
      },
    })
  },
}
