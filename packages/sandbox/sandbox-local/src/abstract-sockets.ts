/**
 * The check a local runner makes before it runs a command on the host's network namespace. Linux ties abstract Unix
 * socket names (`@/tmp/.X11-unix/X0`, D-Bus, ibus, at-spi) to the network namespace, and no mount rule hides them, so
 * a command that shares the namespace can connect to any listening abstract socket of the person's session and act
 * outside the sandbox, for example through X11's XTEST extension. The runners therefore read `/proc/net/unix` at each
 * wrap and refuse the command while any abstract name accepts connections or receives datagrams. A listener that
 * starts after the wrap is not seen.
 *
 * @module @deepseek-ai/dsh-sandbox-local/abstract-sockets
 */

import { readFileSync } from 'node:fs'
import { SandboxUnsupportedPolicyError } from '@deepseek-ai/dsh-sandbox'

/** The kernel's table of Unix sockets. */
export const PROC_NET_UNIX = '/proc/net/unix'

/** The `Flags` bit the kernel sets on a socket that listens (`__SO_ACCEPTCON`). */
const ACCEPTING = 0x10000

/** The `Type` of a datagram socket (`SOCK_DGRAM`). */
const DATAGRAM = 2

/** The most names a refusal lists before it counts the rest. */
const NAMES_LISTED = 5

/**
 * The abstract names that can be connected to or sent to, from the text of `/proc/net/unix`. A listening socket
 * counts, and so does a bound datagram socket, which receives from any sender that knows its name. A connected stream
 * socket does not: it has no pending-connection queue, so nothing new can connect through it, even though it carries
 * the name of the listener it was accepted from. Lines that do not parse are skipped, which can only hide a socket
 * the kernel never writes that way.
 * @param text - the contents of `/proc/net/unix`.
 * @returns the names with their leading `@`, sorted and without duplicates.
 */
export function abstractListeners(text: string): string[] {
  const names = new Set<string>()
  for (const line of text.split('\n').slice(1)) {
    // Num: RefCount Protocol Flags Type St Inode Path; an abstract name may itself hold spaces.
    const match = /^\s*\S+:\s+\S+\s+\S+\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+\S+\s+\S+\s+(@.*)$/u.exec(line)
    if (match === null) continue
    const flags = Number.parseInt(match[1] as string, 16)
    const type = Number.parseInt(match[2] as string, 16)
    if ((flags & ACCEPTING) !== 0 || type === DATAGRAM) names.add(match[3] as string)
  }
  return [...names].sort()
}

/**
 * Why a command on the host's network is refused, naming the sockets and the ways out.
 * @param names - the abstract names found, from {@link abstractListeners}.
 * @returns the refusal's detail.
 */
export function abstractSocketRefusal(names: readonly string[]): string {
  const shown = names.slice(0, NAMES_LISTED).map(name => JSON.stringify(name)).join(', ')
  const more = names.length > NAMES_LISTED ? ` and ${String(names.length - NAMES_LISTED)} more` : ''
  return `the command would share this computer's network, where ${String(names.length)} abstract Unix socket${names.length === 1 ? ' is' : 's are'} listening (${shown}${more}); abstract sockets are tied to the network, not to files, so the sandbox cannot hide them and a command could use them, such as the display server or the session bus, to act outside the sandbox. `
    + 'Set this workspace\'s network to an allowlist or to off, or use a Linux kernel with Landlock abstract-socket scope (6.12 or later, in a launcher this version does not ship). '
    + 'To run the command anyway, accept the risk in Settings, Network, for this workspace. The check runs when a command starts; a socket that starts listening later is not caught'
}

/** What reading the host's abstract Unix sockets found: the listening names, or why the table could not be read. */
export type AbstractSocketCheck =
  | { readonly kind: 'names'; readonly names: readonly string[] }
  | { readonly kind: 'unreadable'; readonly reason: string }

/**
 * Read the host's listening abstract Unix sockets.
 * @param read - reads `/proc/net/unix`; a test hook, the file itself by default.
 * @returns the names (none when nothing listens), or the reason the table could not be read.
 */
export function checkAbstractSockets(read: () => string = () => readFileSync(PROC_NET_UNIX, 'utf8')): AbstractSocketCheck {
  let text: string
  try {
    text = read()
  } catch (error) {
    return { kind: 'unreadable', reason: String(error) }
  }
  return { kind: 'names', names: abstractListeners(text) }
}

/**
 * Refuse a wrap that shares the host's network namespace while an abstract Unix socket listens.
 * @param check - what {@link checkAbstractSockets} found.
 * @throws {SandboxUnsupportedPolicyError} when an abstract socket listens, or the table cannot be read, because the
 *   check cannot then tell and the command is refused.
 */
export function refuseAbstractSockets(check: AbstractSocketCheck): void {
  if (check.kind === 'unreadable') {
    throw new SandboxUnsupportedPolicyError(`cannot read ${PROC_NET_UNIX} to check for abstract Unix sockets on the host's network, so the command is refused: ${check.reason}. Set this workspace's network to an allowlist or to off, or accept the risk in Settings, Network, for this workspace`)
  }
  if (check.names.length > 0) throw new SandboxUnsupportedPolicyError(abstractSocketRefusal(check.names))
}
