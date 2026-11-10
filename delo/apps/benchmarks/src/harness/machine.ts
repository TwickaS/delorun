/**
 * The facts that make two results comparable, and nothing that identifies the machine or the person: the processor
 * count and model, the memory, the operating system's kernel release, Node's version, the file system type and clone
 * support of the directory the roots live in, and the load averages before and after the run. No host name, user
 * name or path is read.
 *
 * @module @delo/benchmarks/harness/machine
 */
import { execFileSync } from 'node:child_process'
import { constants, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch, cpus, loadavg, platform, release, totalmem } from 'node:os'
import { join } from 'node:path'

/** What a result records about the machine. */
export interface MachineFacts {
  /** `process.platform`. */
  readonly platform: string
  /** `process.arch`. */
  readonly arch: string
  /** The kernel release. */
  readonly kernel: string
  /** Logical processors. */
  readonly cpus: number
  /** The first processor's model name. */
  readonly cpuModel: string
  /** Total memory, in GiB, to one decimal. */
  readonly memoryGiB: number
  /** Node's version. */
  readonly node: string
  /** The file system type of the directory the roots live in. */
  readonly fileSystem: string
  /** Whether that file system clones a file (`COPYFILE_FICLONE_FORCE` succeeds). */
  readonly clone: boolean
}

/**
 * The file system type of a directory, as `stat -f` names it.
 * @param directory - the directory.
 * @returns the type, or `unknown` when `stat` cannot tell.
 */
export function fileSystemType(directory: string): string {
  try {
    return execFileSync('stat', ['-f', '-c', '%T', directory], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch (_unavailable) {
    // `stat -f` exists on Linux; elsewhere the type is not recorded.
    return 'unknown'
  }
}

/**
 * Whether a directory's file system clones files.
 * @param directory - the directory.
 * @returns true when a forced clone of a small file succeeds.
 */
export function clonesFiles(directory: string): boolean {
  const probe = mkdtempSync(join(directory, 'clone-probe-'))
  try {
    writeFileSync(join(probe, 'a'), 'clone probe\n')
    copyFileSync(join(probe, 'a'), join(probe, 'b'), constants.COPYFILE_FICLONE_FORCE)
    return true
  } catch (_noClone) {
    // ENOTSUP or EXDEV: the file system copies instead of cloning.
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}

/**
 * The machine's facts.
 * @param rootsDirectory - the directory the roots are created in.
 * @returns the facts.
 */
export function machineFacts(rootsDirectory: string): MachineFacts {
  const processors = cpus()
  return {
    platform: platform(),
    arch: arch(),
    kernel: release(),
    cpus: processors.length,
    cpuModel: processors[0]?.model.trim() ?? 'unknown',
    memoryGiB: Math.round(totalmem() / 1024 ** 3 * 10) / 10,
    node: process.version,
    fileSystem: fileSystemType(rootsDirectory),
    clone: clonesFiles(rootsDirectory),
  }
}

/**
 * The one-, five- and fifteen-minute load averages, to two decimals.
 * @returns the three averages.
 */
export function loadAverages(): readonly [number, number, number] {
  const [one, five, fifteen] = loadavg().map(value => Math.round(value * 100) / 100)
  return [one!, five!, fifteen!]
}

/**
 * The share of the last ten seconds in which some task waited on storage: `some avg10` of `/proc/pressure/io`, in
 * percent. A run that measures while the disk is this busy measures the disk.
 * @param text - the file's text; read from `/proc/pressure/io` by default.
 * @returns the percentage, or `undefined` where the kernel reports no pressure information.
 */
export function ioPressure(text?: string): number | undefined {
  let content = text
  if (content === undefined) {
    try {
      content = readFileSync('/proc/pressure/io', 'utf8')
    } catch (_unavailable) {
      // A kernel without pressure stall information, or a system other than Linux.
      return undefined
    }
  }
  const match = /^some avg10=(\d+(?:\.\d+)?)/mu.exec(content)
  return match === null ? undefined : Number(match[1])
}
