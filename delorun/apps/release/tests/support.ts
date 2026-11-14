/**
 * Fixtures for the closure, archive and rebuild specs: temporary directories removed when the test ends, staged
 * trees written from a path-to-content map, a minimal PE image with and without an Authenticode table, and the
 * release entry points run as child processes from the repository root.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestContext } from 'vitest'

/** The repository root, four directories above this file. */
export const REPO = fileURLToPath(new URL('../../../../', import.meta.url))

/** The local `tsx` binary that runs the TypeScript entry points. */
const TSX = join(REPO, 'node_modules/.bin/tsx')

/**
 * A temporary directory removed when the test ends.
 * @param test - the running test.
 * @param prefix - the directory name's prefix.
 * @returns the directory's path.
 */
export function scratch(test: TestContext, prefix = 'delorun-release-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  test.onTestFinished(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  return directory
}

/** One staged file: its bytes, and whether it is executable. */
export type StagedContent = string | Buffer | { readonly data: string | Buffer, readonly executable: true }

/**
 * Write a staged tree.
 * @param root - the tree's root, created when missing.
 * @param files - relative path to content.
 * @param fileMode - the mode of non-executable files, so trees with different modes can be compared.
 */
export function writeTree(root: string, files: Readonly<Record<string, StagedContent>>, fileMode = 0o644): void {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    const executable = typeof content === 'object' && !Buffer.isBuffer(content)
    writeFileSync(absolute, executable ? content.data : content)
    chmodSync(absolute, executable ? 0o755 : fileMode)
  }
}

/**
 * A minimal PE32+ image: DOS header, PE signature, COFF header, an optional header with 16 data directories, and a
 * body standing in for code.
 * @param body - the bytes after the headers.
 * @returns the unsigned image.
 */
export function peImage(body: Buffer): Buffer {
  const header = Buffer.alloc(0x40 + 24 + 240)
  header.write('MZ', 0, 'ascii')
  header.writeUInt32LE(0x40, 0x3c)
  header.writeUInt32LE(0x00004550, 0x40)
  header.writeUInt16LE(0x8664, 0x44)
  header.writeUInt16LE(240, 0x40 + 20)
  const optional = 0x40 + 24
  header.writeUInt16LE(0x20b, optional)
  header.writeUInt32LE(16, optional + 108)
  return Buffer.concat([header, body])
}

/**
 * A DER SEQUENCE around content, standing in for a PKCS #7 SignedData blob.
 * @param content - the SEQUENCE's content.
 * @returns the encoded SEQUENCE, with a short or long length form as its length needs.
 */
export function derSequence(content: Buffer): Buffer {
  if (content.byteLength < 0x80) return Buffer.concat([Buffer.from([0x30, content.byteLength]), content])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(content.byteLength)
  const digits = length.subarray(length.findIndex(byte => byte !== 0))
  return Buffer.concat([Buffer.from([0x30, 0x80 | digits.byteLength]), digits, content])
}

/**
 * One `WIN_CERTIFICATE` entry: its length, revision, certificate type and body, padded to 8 bytes.
 * @param body - the entry's body; a {@link derSequence} for a valid entry.
 * @param revision - the revision to write; 0x0200 for a valid entry.
 * @param type - the certificate type to write; 0x0002 for a valid entry.
 * @param padding - the byte the alignment padding repeats; 0 for a valid entry.
 * @returns the entry, padded to 8 bytes.
 */
export function winCertificate(body: Buffer, revision = 0x0200, type = 0x0002, padding = 0): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32LE(8 + body.byteLength, 0)
  header.writeUInt16LE(revision, 4)
  header.writeUInt16LE(type, 6)
  const entry = Buffer.concat([header, body])
  return Buffer.concat([entry, Buffer.alloc((8 - (entry.byteLength % 8)) % 8, padding)])
}

/**
 * Sign a PE image the way signing tools lay it out: pad to 8 bytes, append a certificate table, point the security
 * directory at it and set a checksum.
 * @param image - the unsigned image.
 * @param certificate - the table's bytes, such as one {@link winCertificate} entry.
 * @param checksum - the header checksum to write.
 * @returns the signed image.
 */
export function signPe(image: Buffer, certificate: Buffer, checksum: number): Buffer {
  const padded = Buffer.alloc(Math.ceil(image.byteLength / 8) * 8)
  image.copy(padded)
  const signed = Buffer.concat([padded, certificate])
  const optional = 0x40 + 24
  signed.writeUInt32LE(checksum, optional + 64)
  signed.writeUInt32LE(padded.byteLength, optional + 112 + 4 * 8)
  signed.writeUInt32LE(certificate.byteLength, optional + 112 + 4 * 8 + 4)
  return signed
}

/** A finished entry-point run. */
export interface RunResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run a release entry point, from the repository root unless another directory is named.
 * @param entry - the path under `delorun/apps/release/src/`.
 * @param args - its arguments.
 * @param env - extra environment variables.
 * @param cwd - the working directory, the repository root by default.
 * @returns its exit status and output.
 */
export function runEntry(entry: string, args: readonly string[], env: NodeJS.ProcessEnv = {}, cwd: string = REPO): RunResult {
  const result = spawnSync(TSX, [join(REPO, 'delorun/apps/release/src', entry), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 50_000 })
  if (result.status === null) throw new Error(`${entry} ended by signal ${String(result.signal)}: ${result.stderr}`)
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}
