/**
 * Waits for enough free memory and disk before a build or a browser starts. The machine is shared, so the pass waits
 * instead of competing.
 *
 * @module @delorun/website/review/resources
 */
import { readFileSync, statfsSync } from 'node:fs'

/** Memory the pass needs available, in gigabytes. */
export const MIN_MEMORY_GB = 4
/** Disk the pass needs free, in gigabytes. */
export const MIN_DISK_GB = 5

/** What the machine has free. */
export interface Resources { readonly memoryGb: number; readonly diskGb: number }

/**
 * Reads the free memory and disk.
 * @param path - a path on the disk to check.
 * @returns the figures in gigabytes.
 */
export function readResources(path = '/'): Resources {
  const meminfo = readFileSync('/proc/meminfo', 'utf8')
  const kb = Number(/MemAvailable:\s+(\d+) kB/.exec(meminfo)?.[1] ?? '0')
  const fs = statfsSync(path)
  return { memoryGb: kb / 1024 / 1024, diskGb: (fs.bavail * fs.bsize) / 1024 ** 3 }
}

/**
 * Whether the figures meet the minimum.
 * @param resources - the figures.
 * @returns the reasons for waiting; empty when the pass may start.
 */
export function shortfalls(resources: Resources): string[] {
  const out: string[] = []
  if (resources.memoryGb < MIN_MEMORY_GB) out.push(`${resources.memoryGb.toFixed(1)} GB of memory available, need ${String(MIN_MEMORY_GB)}`)
  if (resources.diskGb < MIN_DISK_GB) out.push(`${resources.diskGb.toFixed(1)} GB of disk free, need ${String(MIN_DISK_GB)}`)
  return out
}

/**
 * Waits until the machine has enough free, printing why while it waits.
 * @param waitMs - the pause between checks.
 */
export async function waitForResources(waitMs = 15000): Promise<void> {
  for (;;) {
    const reasons = shortfalls(readResources())
    if (reasons.length === 0) return
    console.log(`waiting: ${reasons.join('; ')}`)
    await new Promise(done => setTimeout(done, waitMs))
  }
}
