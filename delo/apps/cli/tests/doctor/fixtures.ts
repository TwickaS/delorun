/**
 * Shared fixtures for the `delorun doctor` specs: a DeepSeek key in the format
 * the check accepts, loopback ports held by a listener, a probe for a leaked
 * secret, the fake `docker` and `bwrap` programs that the specs write into
 * temporary directories, and the check names a run prints on this platform.
 * Nothing here calls a service or a real Docker engine.
 *
 * @module @delo/cli/tests/doctor/fixtures
 */
import { writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'

/** Whether the host has POSIX modes and shell scripts; the Windows lane skips the cases that need them. */
export const POSIX = process.platform !== 'win32'

/** A fixture key in the format the check accepts. It is not a credential. */
export const GOOD_KEY = 'sk-fixture0123456789abcdef'

/** A fake `docker`'s body that answers `version --format {{.Server.Version}}` and rejects any other arguments. */
export const ANSWERING_DOCKER = [
  'if [ "$1" != version ] || [ "$2" != --format ] || [ "$3" != \'{{.Server.Version}}\' ]; then',
  '  echo "unexpected arguments: $*" >&2',
  '  exit 3',
  'fi',
  'echo 27.3.1',
  '',
].join('\n')

/**
 * Write a fake `bwrap` that creates its sandbox into a directory on a case's search path, so the Linux `sandbox`
 * line passes whatever this machine's bubblewrap can do.
 * @param directory - the directory.
 */
export function usableBwrap(directory: string): void {
  writeFileSync(join(directory, 'bwrap'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
}

/** The check names one run prints, sorted, without the import line: the `sandbox` line is printed on Linux only. */
export const CHECK_NAMES: readonly string[] = ['docker', 'home', 'key', 'port', 'release-log', ...process.platform === 'linux' ? ['sandbox'] : [], 'update']

/** A fake `docker`'s body for an installed program whose engine is not running. */
export const FAILING_DOCKER = [
  'echo "Cannot connect to the Docker daemon. Is the docker daemon running?" >&2',
  'exit 1',
  '',
].join('\n')

/**
 * Listen on an ephemeral loopback port, so the caller can use a port that is in use.
 * @returns the listening server and its port.
 * @throws when the listener cannot start or has no TCP address.
 */
export function listenOnEphemeralPort(): Promise<{ server: Server, port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('the listener has no TCP address'))
        return
      }
      resolve({ server, port: address.port })
    })
  })
}

/**
 * Close a listener from {@link listenOnEphemeralPort}.
 * @param server - the listener.
 * @returns when the listener has closed.
 */
export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => { resolve() })
  })
}

/**
 * Whether any run of six consecutive characters of a secret appears in the text.
 * @param text - the text the program printed.
 * @param secret - the secret that must not appear in it.
 * @returns true when a six-character part of the secret appears in the text.
 */
export function leaksPartOf(text: string, secret: string): boolean {
  for (let start = 0; start + 6 <= secret.length; start += 1) {
    if (text.includes(secret.slice(start, start + 6))) return true
  }
  return false
}
