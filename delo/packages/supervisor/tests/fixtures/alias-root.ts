/**
 * Resolves one workspace root against a home's rules and prints the outcome, for the roots spec, which runs it inside
 * a mount namespace where the root is a bind-mounted alias of another directory.
 * Arguments: the Delo home, the OS home the rules compare with, and the root.
 */
import { loadRootRules, resolveWorkspaceRoot, SupervisorError } from '../../src/index.ts'

const [home = '', osHome = '', root = ''] = process.argv.slice(2)
try {
  process.stdout.write(`accepted ${await resolveWorkspaceRoot(root, await loadRootRules(home, osHome), [])}\n`)
} catch (error) {
  if (!(error instanceof SupervisorError)) throw error
  process.stdout.write(`${error.code} ${error.detail ?? ''}\n`)
}
