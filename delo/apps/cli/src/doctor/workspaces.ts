/**
 * The `workspaces` line of `delorun doctor`: opens the workspace registry file read-only and reports whether Delo can
 * start from it, the records it would set aside, the files it already set aside, and the command that restores the
 * previous good copy. Nothing is written.
 * @module @delo/cli/doctor/workspaces
 */
import { describeRegistry, readRegistryStore } from '../workspace-store.ts'
import type { CheckResult } from './checks.ts'

/** The command that restores the previous good copy. */
const FIX = 'delorun recover workspaces restores the previous good copy after asking'

/**
 * The `workspaces` line.
 * @param home - the resolved Delo home.
 * @returns the line's result: `pass` for a readable consistent registry, `warn` when records were set aside before or
 *   Delo would set some aside now, `fail` for a file that does not read.
 * @throws {Error} when a registry file exists and cannot be read.
 */
export async function checkWorkspaces(home: string): Promise<CheckResult> {
  const store = await readRegistryStore(home)
  const aside = store.quarantined.length === 0 ? '' : ` Records set aside earlier are in ${store.quarantined.join(', ')}.`
  const backup = store.previous.inspection === undefined ? ' No previous copy exists.' : ` A previous copy exists; ${FIX}.`
  const { inspection } = store.current
  if (inspection === undefined) {
    return { name: 'workspaces', status: store.quarantined.length === 0 ? 'pass' : 'warn', message: `no workspace registry file exists yet.${aside}` }
  }
  if (inspection.state === 'unreadable') {
    return { name: 'workspaces', status: 'fail', message: `the workspace registry ${store.current.path} does not read (${inspection.reason}); Delo starts without its workspaces and sets the file aside.${backup}${aside}` }
  }
  if (inspection.problems.length > 0) {
    return { name: 'workspaces', status: 'warn', message: `the workspace registry holds records Delo would set aside at the next start: ${inspection.problems.join('; ')}.${backup}${aside}` }
  }
  const count = describeRegistry(store.current)
  return { name: 'workspaces', status: store.quarantined.length === 0 ? 'pass' : 'warn', message: `the workspace registry holds ${count}.${aside}` }
}
