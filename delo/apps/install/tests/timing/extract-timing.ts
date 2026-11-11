/**
 * Timing probe (not part of the package) for unpacking a runtime archive: it times reading the archive alone (gunzip
 * and the tar reader), reading and hashing every entry, and {@link extractArchive} into a new staging directory, each
 * against the same real closure. `sync` runs before each extraction so one sample's writeback does not slow the next.
 *
 * `node_modules/.bin/tsx delo/apps/install/tests/timing/extract-timing.ts <archive.tar.gz> <files.json>
 * [--repeat 3] [--base <directory>]`, where `files.json` is the closure's signed file list. It needs the runtime's size
 * free under the base directory, the system's temporary directory by default, and removes everything it wrote.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { cpus, loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeFileList } from '@delo/contract-release-manifest'
import { archiveEntries } from '@delo/release-formats/archive/inspect'
import { extractArchive } from '../../src/extract.ts'

/**
 * The value of a `--name value` option.
 * @param argv - the arguments.
 * @param name - the option's name.
 * @param fallback - the value when it is absent.
 * @returns the value.
 */
function option(argv: readonly string[], name: string, fallback: string): string {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : argv[at + 1] ?? fallback
}

/**
 * Milliseconds an operation takes.
 * @param work - the operation.
 * @returns the elapsed milliseconds.
 */
async function timed(work: () => Promise<unknown>): Promise<number> {
  const started = performance.now()
  await work()
  return performance.now() - started
}

/**
 * The median of samples.
 * @param samples - the samples.
 * @returns the median.
 */
function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

/**
 * Seconds with one decimal.
 * @param ms - milliseconds.
 * @returns the text.
 */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const [archive, listFile] = argv
  if (archive === undefined || listFile === undefined) throw new Error('usage: extract-timing.ts <archive.tar.gz> <files.json> [--repeat 3] [--base <directory>]')
  const repeat = Number(option(argv, 'repeat', '3'))
  const base = option(argv, 'base', tmpdir())
  const files = (JSON.parse(readFileSync(listFile, 'utf8')) as { readonly signed: RuntimeFileList }).signed
  const read: number[] = []
  const hashed: number[] = []
  const extracted: number[] = []
  for (let sample = 0; sample < repeat; sample++) {
    read.push(await timed(async () => {
      for await (const _entry of archiveEntries(archive, 'tar.gz')) { /* reading only */ }
    }))
    hashed.push(await timed(async () => {
      for await (const entry of archiveEntries(archive, 'tar.gz')) createHash('sha256').update(entry.data).digest('hex')
    }))
    const parent = mkdtempSync(join(base, 'delo-extract-timing-'))
    try {
      spawnSync('sync', { timeout: 120_000 })
      extracted.push(await timed(() => extractArchive({ archive, format: 'tar.gz', files, directory: join(parent, 'staging') })))
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  }
  process.stdout.write([
    `files: ${String(files.files.length)}, CPUs: ${String(cpus().length)}, load average: ${loadavg().map(value => value.toFixed(1)).join(' ')}`,
    `read the archive: ${seconds(median(read))} (${read.map(seconds).join(', ')})`,
    `read and hash every entry: ${seconds(median(hashed))} (${hashed.map(seconds).join(', ')})`,
    `extractArchive: ${seconds(median(extracted))} (${extracted.map(seconds).join(', ')})`,
    '',
  ].join('\n'))
}

await main()
