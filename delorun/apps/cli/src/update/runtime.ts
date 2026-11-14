/**
 * The runtime this CLI runs as, and the handover a home process inherits when an update started it (contract C19):
 * a file of this package under `<home>/runtimes/<version>/` runs C1's stored runtime, which updates and rollbacks
 * apply to, and so does one under a composed tree of that runtime, `<home>/changes/harness/<version>/run/<digest>/`
 * (contract C21, "Harness edits"); anywhere else it runs as this package's own version, as in a source checkout.
 *
 * @module @delorun/cli/update/runtime
 */
import { fstatSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CHANGES_ENTRIES, harnessDirectory } from '@delorun/changes'
import { DELORUN_HOME_ENTRIES, type RuntimeVersion } from '@delorun/contract-home-layout'
import { HANDOVER_FD } from '@delorun/contract-home-process'
import { openHandoverPipe, type HandoverPipe } from '@delorun/home-process'
import { parseRuntimeVersion } from '@delorun/runtime-store'

/** The runtime a home process runs. */
export interface RunningRuntime {
  /** The version. */
  readonly version: RuntimeVersion
  /** Whether it runs from C1's runtime store, so updates and rollbacks apply. */
  readonly store: boolean
  /**
   * The composed tree it runs from, `<home>/changes/harness/<version>/run/<digest>`, when the person's approved changes
   * to the harness are in place (contract C21, "Harness edits"); absent when it runs the signed installation.
   */
  readonly composed?: string
}

/**
 * This package's own version, which the home locks a CLI command takes record.
 * @returns the version in this package's manifest.
 */
export function runningVersion(): RuntimeVersion {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
  return brandString<RuntimeVersion>(manifest.version)
}

/** A composed tree's digest: 64 lowercase hexadecimal digits. */
const TREE_DIGEST = /^[0-9a-f]{64}$/u

/**
 * The runtime a file of this package runs from: the store's version when the file lies under `<home>/runtimes/<version>/`,
 * or under a composed tree `<home>/changes/harness/<version>/run/<digest>/` of that version, otherwise this package's
 * own version, as in a source checkout.
 * @param home - the resolved Delorun home.
 * @param file - a file of this package.
 * @returns the version, whether it runs from the store, and the composed tree it runs from.
 */
export function runtimeOfFile(home: string, file: string): RunningRuntime {
  const root = join(home, DELORUN_HOME_ENTRIES.runtimes) + sep
  if (file.startsWith(root)) {
    const rest = file.slice(root.length)
    const end = rest.indexOf(sep)
    const version = parseRuntimeVersion(end === -1 ? rest : rest.slice(0, end))
    if (version !== undefined) return { version, store: true }
  }
  const harness = harnessDirectory(home) + sep
  if (file.startsWith(harness)) {
    const [name = '', run, digest, ...below] = file.slice(harness.length).split(sep)
    const version = parseRuntimeVersion(name)
    if (version !== undefined && run === CHANGES_ENTRIES.harnessRun && digest !== undefined && TREE_DIGEST.test(digest) && below.length > 0) {
      return { version, store: true, composed: join(harness, name, run, digest) }
    }
  }
  return { version: runningVersion(), store: false }
}

/**
 * The handover pipe this process inherits when an update started it as a successor.
 * @param fd - the descriptor to read; C19's {@link HANDOVER_FD}, 3, in a real start.
 * @returns the pipe, or `undefined` when the descriptor is closed or is not a socket or a pipe.
 * @throws {Error} when the descriptor is a pipe whose first line is not a valid handover line.
 */
export async function inheritedHandover(fd: number = HANDOVER_FD): Promise<HandoverPipe | undefined> {
  let inherited = false
  try {
    const stat = fstatSync(fd)
    inherited = stat.isSocket() || stat.isFIFO()
  } catch (_closed) {
    // EBADF: nothing is open on the descriptor, so this is a fresh start.
  }
  return inherited ? openHandoverPipe(fd) : undefined
}
