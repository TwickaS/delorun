/**
 * A signed installation for the harness specs: a fake runtime's files under `runtimes/<version>/` of a temporary home,
 * with the signed file list a verified runtime gives.
 *
 * @module @delo/changes/tests/harness-fixture
 */
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessContext, SignedFile, SignedRuntime } from '../src/harness.ts'
import { attestTerminal, type AtComputer } from '../src/records.ts'
import { temporaryDirectory, writeFiles } from './support.ts'

/** The runtime version every harness spec uses. */
export const RUNTIME = '1.2.3'

/** A file of the fixture's `app/` directory every spec edits. */
export const START_FILE = 'app/node_modules/@delo/cli/src/start.js'

/** The fixture's signed files and their content. */
export const SIGNED_FILES: Readonly<Record<string, string>> = {
  'node/bin/node': '#!/bin/sh\necho node\n',
  'app/package.json': '{"name":"closure"}\n',
  'app/node_modules/@delo/cli/src/bin.js': 'import "./start.js"\n',
  [START_FILE]: 'export const start = 1\n',
  'app/node_modules/@delo/cli/run.sh': '#!/bin/sh\necho run\n',
}

/** The fixture's executable files. */
const EXECUTABLE = new Set(['node/bin/node', 'app/node_modules/@delo/cli/run.sh'])

/** A home with an installed runtime. */
export interface HarnessFixture {
  readonly home: string
  readonly signed: SignedRuntime
  readonly ctx: HarnessContext
  /** How many times the context's signed installation was read. */
  readonly reads: () => number
}

/**
 * The signed list of a directory's files.
 * @param directory - the installation.
 * @returns every regular file with its length, SHA-256 and execute bit.
 */
export function listOf(directory: string): SignedFile[] {
  const files: SignedFile[] = []
  const walk = (path: string, prefix: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(path, entry.name), relative)
      else {
        const bytes = readFileSync(join(path, entry.name))
        files.push({ path: relative, length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), executable: (lstatSync(join(path, entry.name)).mode & 0o100) !== 0 })
      }
    }
  }
  walk(directory, '')
  return files
}

/**
 * A home whose store has runtime {@link RUNTIME} installed with {@link SIGNED_FILES}, read-only as an installation is.
 * @param now - the clock of the context.
 * @returns the fixture.
 */
export function harnessFixture(now?: () => Date): HarnessFixture {
  const home = temporaryDirectory('delo-harness-')
  const directory = join(home, 'runtimes', RUNTIME)
  writeFiles(directory, SIGNED_FILES)
  for (const path of EXECUTABLE) chmodSync(join(directory, ...path.split('/')), 0o755)
  const signed: SignedRuntime = { directory, files: listOf(directory) }
  let reads = 0
  const ctx: HarnessContext = {
    home,
    runtime: RUNTIME,
    signed: () => {
      reads += 1
      return Promise.resolve(signed)
    },
    ...now === undefined ? {} : { now },
  }
  return { home, signed, ctx, reads: () => reads }
}

/** A terminal proof. */
export function terminal(): AtComputer {
  return attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } })
}

/**
 * Every file under a directory with its bytes, for comparing a tree before and after.
 * @param directory - the directory.
 * @returns the bytes and mode by relative path.
 */
export function snapshotOf(directory: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const file of listOf(directory)) files[file.path] = `${file.sha256}:${(lstatSync(join(directory, ...file.path.split('/'))).mode & 0o777).toString(8)}`
  return files
}
