/**
 * A directory only this user can reach, in which the shared pass store and the slot budget keep their files, so another
 * user of the machine can neither plant a pass or a grant nor remove one.
 *
 * @module @delorun/tools/checks/private-dir
 */
import { lstatSync, mkdirSync } from 'node:fs'

/**
 * Create a directory with mode 0700 when it does not exist, and refuse one another user could reach or replace.
 * @param dir - the directory.
 * @param uid - the user it must belong to, `process.getuid()`.
 * @param what - what it holds, which begins each refusal, such as `the shared pass cache`.
 * @param fix - how a person repairs it, which ends each refusal.
 * @throws Error when it is a symbolic link or not a directory, belongs to another user, or grants any access to the group
 * or others.
 */
export function ensurePrivateDir(dir: string, uid: number, what: string, fix: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (!stat.isDirectory()) throw new Error(`${what} ${dir} is not a directory (a symbolic link is refused); ${fix}`)
  if (stat.uid !== uid) throw new Error(`${what} ${dir} belongs to user ${String(stat.uid)}, not to this user; ${fix}`)
  if ((stat.mode & 0o077) !== 0) throw new Error(`${what} ${dir} has mode ${(stat.mode & 0o777).toString(8)}, which other users can reach; ${fix}`)
}
