/**
 * The check of a draft's `npm[]` entries against the packed packages in the release directory: each entry's tarball,
 * named as `npm pack` names it, must be there, its npm integrity (`sha512-` and the base64 SHA-512 of the tarball's
 * bytes, npm's `dist.integrity`) must be the entry's, and the `package/package.json` it holds must carry the entry's
 * name and version. The tar reader here reads what `npm pack` writes, whose headers leave the owner fields empty, which
 * the canonical reader of `@delo/release-formats/archive/tar` refuses.
 *
 * @module @delo/release/sign/npm-package
 */
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { NpmPackageRef } from '@delo/contract-release-manifest'
import { parseStrictJson } from '@delo/release-formats/sign/json'
import { z } from 'zod'

/** The largest packed package signing reads, in bytes. */
const MAX_TARBALL_BYTES = 64 * 1024 * 1024

/** The most bytes a packed package may hold once decompressed. */
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024

/** The largest `package.json` signing parses, in bytes. */
const MAX_MANIFEST_BYTES = 1024 * 1024

/** npm's package name rule: an optional scope and a name of lowercase letters, digits and `-._~`. */
const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/u

/** The path `npm pack` gives the package's manifest in its tarball. */
const MANIFEST_PATH = 'package/package.json'

const BLOCK = 512

/** The fields of a packed `package.json` that signing compares; the others are the package's own. */
const PackedFieldsSchema = z.looseObject({ name: z.string(), version: z.string() })

/**
 * The file name `npm pack` gives a package's tarball: the name without its `@`, the scope's `/` as `-`, then
 * `-<version>.tgz`.
 * @param name - the package name.
 * @param version - the package version.
 * @returns the file name, such as `delorun-0.1.0.tgz`.
 */
export function npmTarballName(name: string, version: string): string {
  return `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`
}

/**
 * npm's integrity string of a tarball.
 * @param bytes - the tarball's bytes.
 * @returns `sha512-` and the base64 SHA-512 of the bytes.
 */
export function npmIntegrity(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

function field(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return (end < 0 ? raw : raw.subarray(0, end)).toString('utf8')
}

function octal(block: Buffer, offset: number, length: number, name: string): number {
  const text = field(block, offset, length).trim()
  if (!/^[0-7]+$/u.test(text)) throw new Error(`a tar header's ${name} is not an octal number`)
  return Number.parseInt(text, 8)
}

function paxPath(records: Buffer): string | undefined {
  let path: string | undefined
  let offset = 0
  while (offset < records.byteLength) {
    const space = records.indexOf(0x20, offset)
    const length = Number.parseInt(records.subarray(offset, space).toString('ascii'), 10)
    if (space < 0 || !Number.isSafeInteger(length) || length <= space - offset || offset + length > records.byteLength || records[offset + length - 1] !== 0x0a) {
      throw new Error('a pax record is malformed')
    }
    const record = records.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals < 0) throw new Error('a pax record is malformed')
    if (record.slice(0, equals) === 'path') path = record.slice(equals + 1)
    offset += length
  }
  return path
}

/**
 * The `package/package.json` of a packed npm package.
 * @param tarball - the gzipped tarball's bytes.
 * @returns the manifest file's bytes.
 * @throws Error when the tarball does not decompress within 256 MiB, a header's checksum or a number does not read,
 *   an entry is neither a file, a directory nor a pax header, or the tarball holds no or more than one
 *   `package/package.json`.
 */
export function packedManifest(tarball: Uint8Array): Buffer {
  const tar = gunzipSync(tarball, { maxOutputLength: MAX_UNPACKED_BYTES })
  const found: Buffer[] = []
  let pending: string | undefined
  let offset = 0
  for (;;) {
    const block = tar.subarray(offset, offset + BLOCK)
    if (block.byteLength < BLOCK) throw new Error('the tar stream ends inside a header')
    if (block.every(byte => byte === 0)) break
    let sum = 0
    for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 0x20 : block[index]!
    if (octal(block, 148, 8, 'checksum') !== sum) throw new Error('a tar header checksum does not match')
    const size = octal(block, 124, 12, 'size')
    const start = offset + BLOCK
    if (start + size > tar.byteLength) throw new Error('the tar stream ends inside an entry')
    const data = tar.subarray(start, start + size)
    offset = start + Math.ceil(size / BLOCK) * BLOCK
    const type = String.fromCharCode(block[156]!)
    if (type === 'x') {
      pending = paxPath(data)
      continue
    }
    if (type === 'g') continue
    const prefix = field(block, 345, 155)
    const name = field(block, 0, 100)
    const path = pending ?? (field(block, 257, 6) === 'ustar' && prefix !== '' ? `${prefix}/${name}` : name)
    pending = undefined
    if (type === '5') continue
    if (type !== '0' && type !== '\0') throw new Error(`the tar entry ${JSON.stringify(path)} has type ${JSON.stringify(type)}, which a packed package does not hold`)
    if (path === MANIFEST_PATH) found.push(data)
  }
  if (found.length !== 1) throw new Error(`the tarball holds ${String(found.length)} ${MANIFEST_PATH} files, not one`)
  return found[0]!
}

/**
 * Check a draft's npm package against its packed tarball in the release directory.
 * @param directory - the release directory.
 * @param entry - the draft's `npm[]` entry.
 * @returns the problem, or `undefined` when the tarball is there with the entry's integrity, name and version.
 */
export async function npmPackageProblem(directory: string, entry: NpmPackageRef): Promise<string | undefined> {
  if (!NPM_NAME.test(entry.name)) return `the draft's npm package name ${JSON.stringify(entry.name)} is not an npm package name`
  const name = npmTarballName(entry.name, entry.version)
  const path = join(directory, name)
  let bytes: Buffer
  try {
    const stat = await lstat(path)
    if (!stat.isFile()) throw new Error('it is not a regular file')
    if (stat.size > MAX_TARBALL_BYTES) throw new Error(`it has ${String(stat.size)} bytes, above the limit of ${String(MAX_TARBALL_BYTES)}`)
    bytes = await readFile(path)
  } catch (error) {
    return `the draft lists the npm package ${entry.name}@${entry.version}, but its packed tarball ${name} does not read in ${directory}: ${(error as Error).message}`
  }
  const integrity = npmIntegrity(bytes)
  if (integrity !== entry.integrity) return `the packed tarball ${name} has the integrity ${integrity}, not the ${entry.integrity} the draft lists for ${entry.name}@${entry.version}`
  let manifest: z.infer<typeof PackedFieldsSchema>
  try {
    const parsed = PackedFieldsSchema.safeParse(parseStrictJson(packedManifest(bytes), MAX_MANIFEST_BYTES))
    if (!parsed.success) throw new Error(`${MANIFEST_PATH} is not an object with a string name and version`)
    manifest = parsed.data
  } catch (error) {
    return `the packed tarball ${name} does not read: ${(error as Error).message}`
  }
  if (manifest.name !== entry.name || manifest.version !== entry.version) {
    return `the packed tarball ${name} holds the package ${JSON.stringify(manifest.name)} at version ${JSON.stringify(manifest.version)}, not ${entry.name}@${entry.version}`
  }
  return undefined
}
