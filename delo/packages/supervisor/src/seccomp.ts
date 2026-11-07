/**
 * The seccomp profile a container runs under (contract C9, "Containers"): the file that the verified manifest lists
 * as the image's `seccomp` entry, read from the directory the home process names at launch and checked against its
 * listed length and SHA-256 before its text reaches the engine. Without a listed profile the engine's default profile
 * applies; the supervisor never asks for `unconfined`.
 *
 * @module @delo/supervisor/seccomp
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileRef } from '@delo/contract-release-manifest'
import { SupervisorError } from './errors.ts'

/** Largest seccomp profile the supervisor reads, in bytes; Docker's default profile is under 32 KiB. */
export const SECCOMP_PROFILE_MAX_BYTES = 1_048_576

const FILE_NAME = /^[A-Za-z0-9._+-]+$/

/**
 * Read a listed seccomp profile and check it.
 * @param directory - the directory holding the release's seccomp profile files.
 * @param listed - the manifest's `seccomp` entry for the image.
 * @returns the profile's text, which `createBody` passes to the engine.
 * @throws {SupervisorError} `IMAGE_NOT_IN_MANIFEST` when the name is not one path segment, the file is missing, not a
 *   regular file, or its length or SHA-256 differs from the listed one.
 */
export async function loadSeccompProfile(directory: string, listed: FileRef): Promise<string> {
  const refuse = (reason: string): SupervisorError => new SupervisorError('IMAGE_NOT_IN_MANIFEST', `the listed seccomp profile ${listed.name} ${reason}`)
  if (!FILE_NAME.test(listed.name) || listed.name === '.' || listed.name === '..') throw refuse('is not a file name')
  if (listed.length > SECCOMP_PROFILE_MAX_BYTES) throw refuse(`is larger than ${String(SECCOMP_PROFILE_MAX_BYTES)} bytes`)
  let handle
  try {
    handle = await open(join(directory, listed.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    throw refuse(`cannot be opened (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw refuse('is not a regular file')
    if (stats.size !== listed.length) throw refuse(`has ${String(stats.size)} bytes, not the listed ${String(listed.length)}`)
    const bytes = await handle.readFile()
    if (bytes.length !== listed.length || createHash('sha256').update(bytes).digest('hex') !== listed.sha256) throw refuse('does not match its listed digest')
    return bytes.toString('utf8')
  } finally {
    await handle.close()
  }
}
