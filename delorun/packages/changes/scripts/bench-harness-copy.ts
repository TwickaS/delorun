/**
 * Time the studio's Changes controls on a full-size writable copy of Delorun: the pending read (`show?pending`, which
 * calls {@link harnessChanges}) and an Apply (the route's {@link showHarnessChange} then {@link applyHarnessChange}).
 *
 * It builds a synthetic installed runtime of `--files` regular files (32,686 by default, the size of a release closure)
 * in a throwaway home under the system's temporary directory, makes the writable copy, and then:
 *
 * - reads the pending changes once with no scan cache (`cold`), then `--samples` times with nothing changed (`warm`);
 * - per sample, edits one file of the copy, reads the pending changes (`after edit`), and applies the change as the
 *   studio's Apply route does (`apply`).
 *
 * The signed file list is read once and kept, as the Host's harness context keeps it. No model, network or Host runs.
 * The home is removed at the end unless `--keep` is given; `--home` measures again in a home a `--keep` run left,
 * without building it, from its warm reads on.
 *
 * Run from the repository root: `node --import tsx/esm delorun/packages/changes/scripts/bench-harness-copy.ts
 * [--files N] [--samples N] [--keep] [--home DIR]`.
 *
 * @module @delorun/changes/scripts/bench-harness-copy
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { applyHarnessChange, createHarnessCopy, harnessChanges, harnessCopyDirectory, showHarnessChange, type HarnessContext, type SignedFile, type SignedRuntime } from '../src/index.ts'
import { attestTerminal } from '../src/records.ts'

/** The runtime version of the synthetic installation. */
const RUNTIME = '0.0.1'

/** Where a built home keeps its signed file list, so `--home` need not hash the installation again. */
const SIGNED_LIST = 'bench-signed.json'

/** Files per directory of a synthetic package, and directories per package: an installed package's usual spread. */
const FILES_PER_DIRECTORY = 9
const DIRECTORIES_PER_PACKAGE = 3

/**
 * The size of the synthetic file with an index: mostly 0.5–8 KiB, every 500th 256 KiB, as a bundle is.
 * @param index - the file's index.
 * @returns its size in bytes.
 */
function sizeOf(index: number): number {
  return index % 500 === 0 ? 256 * 1024 : 512 + ((index * 2_654_435_761) >>> 0) % (8 * 1024)
}

/**
 * Write the synthetic installation and its signed file list.
 * @param directory - `runtimes/<version>/`.
 * @param count - how many files `app/` holds.
 * @returns the installation.
 */
function writeInstallation(directory: string, count: number): SignedRuntime {
  const files: SignedFile[] = []
  const write = (path: string, bytes: Buffer, executable = false): void => {
    const absolute = join(directory, ...path.split('/'))
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, bytes)
    chmodSync(absolute, executable ? 0o555 : 0o444)
    files.push({ path, length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), executable })
  }
  write('node/bin/node', Buffer.from('#!/bin/sh\n'), true)
  write('app/package.json', Buffer.from('{"name":"closure"}\n'))
  for (let index = 0; index < count - 1; index++) {
    const per = FILES_PER_DIRECTORY * DIRECTORIES_PER_PACKAGE
    const pkg = Math.floor(index / per)
    const lib = Math.floor((index % per) / FILES_PER_DIRECTORY)
    const body = Buffer.alloc(sizeOf(index), `// file ${String(index)}\n`)
    write(`app/node_modules/pkg-${String(pkg)}/lib-${String(lib)}/file-${String(index % FILES_PER_DIRECTORY)}.js`, body)
  }
  return { directory, files }
}

/**
 * @param work - the measured work.
 * @returns its wall time in milliseconds.
 */
async function timed(work: () => Promise<unknown>): Promise<number> {
  const start = performance.now()
  await work()
  return performance.now() - start
}

/**
 * @param samples - wall times in milliseconds.
 * @returns the median, minimum and maximum, rounded.
 */
function summary(samples: readonly number[]): string {
  const sorted = [...samples].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  return `median ${String(Math.round(median))} ms, min ${String(Math.round(sorted[0]!))}, max ${String(Math.round(sorted.at(-1)!))} (${String(sorted.length)} samples)`
}

const { values } = parseArgs({ options: { files: { type: 'string', default: '32686' }, samples: { type: 'string', default: '5' }, keep: { type: 'boolean', default: false }, home: { type: 'string' } } })
const count = Number.parseInt(values.files, 10)
const sampleCount = Number.parseInt(values.samples, 10)
if (!Number.isSafeInteger(count) || count < 2 || !Number.isSafeInteger(sampleCount) || sampleCount < 1) throw new Error('--files needs a whole number of at least 2 and --samples one of at least 1')

const reused = values.home !== undefined
const home = reused ? realpathSync(values.home!) : realpathSync(mkdtempSync(join(tmpdir(), 'chgperf-bench-')))
chmodSync(home, 0o700)
try {
  const presence = attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } })
  let signed: SignedRuntime
  if (reused) {
    signed = JSON.parse(readFileSync(join(home, SIGNED_LIST), 'utf8')) as SignedRuntime
  } else {
    signed = writeInstallation(join(home, 'runtimes', RUNTIME), count)
    writeFileSync(join(home, SIGNED_LIST), JSON.stringify(signed))
  }
  const ctx: HarnessContext = { home, runtime: RUNTIME, signed: () => Promise.resolve(signed) }
  if (!reused) {
    const copying = await timed(async () => createHarnessCopy(ctx, presence))
    console.log(`installation: ${String(count)} files; copy made in ${String(Math.round(copying))} ms`)
    console.log(`pending read, cold: ${summary([await timed(async () => harnessChanges(ctx))])}`)
  }
  const warm: number[] = []
  for (let sample = 0; sample < sampleCount; sample++) warm.push(await timed(async () => harnessChanges(ctx)))
  console.log(`pending read, warm: ${summary(warm)}`)

  const afterEdit: number[] = []
  const apply: number[] = []
  const copy = join(harnessCopyDirectory(home, RUNTIME), 'app')
  for (let sample = 0; sample < sampleCount; sample++) {
    const file = `node_modules/pkg-${String(sample)}/lib-0/file-1.js`
    writeFileSync(join(copy, ...file.split('/')), `// edited at ${new Date().toISOString()}\n`)
    let pending: Awaited<ReturnType<typeof harnessChanges>> | undefined
    afterEdit.push(await timed(async () => { pending = await harnessChanges(ctx) }))
    const change = pending?.changes.find(candidate => candidate.file === `app/${file}`)
    if (change === undefined) throw new Error(`the pending read did not find the edit of app/${file}`)
    apply.push(await timed(async () => {
      await showHarnessChange(ctx, change.id)
      await applyHarnessChange(ctx, change.id, presence, { reviewedTo: change.to })
    }))
  }
  console.log(`pending read, after one edit: ${summary(afterEdit)}`)
  console.log(`apply (show, then apply, as the route does): ${summary(apply)}`)
} finally {
  if (values.keep || reused) console.log(`kept ${home}`)
  else rmSync(home, { recursive: true, force: true })
}
