/**
 * The measured run's network: a new network namespace that holds only a loopback interface, so no request of the
 * harness or of any process it starts can leave the machine. The harness re-runs itself inside one through
 * `unshare`: an outer user namespace that maps the person to root brings the loopback interface up, and an inner one
 * maps the person back to their own user and group ids, so every process runs as the person and the product's
 * ownership checks and its sandbox behave as they do outside. No privilege is needed beyond unprivileged user
 * namespaces; where they are missing the harness refuses to measure.
 *
 * @module @delorun/benchmarks/harness/isolation
 */
import { spawn } from 'node:child_process'
import { networkInterfaces } from 'node:os'

/** The variable the re-run carries, so the run inside the namespace does not re-run itself again. */
export const ISOLATED_ENV = 'DELORUN_BENCHMARK_NETNS'

/** A refusal to measure without the isolated network. */
export class IsolationRefusal extends Error {
  override readonly name = 'IsolationRefusal'
}

/**
 * The command that runs a process in a loopback-only network namespace as the given user.
 * @param command - the executable.
 * @param args - its arguments.
 * @param ids - the user and group ids to run as.
 * @returns the `unshare` command and its arguments.
 */
export function isolatedCommand(command: string, args: readonly string[], ids: { readonly uid: number, readonly gid: number }): { readonly command: string, readonly args: readonly string[] } {
  const inner = `exec unshare --user --map-user=${String(ids.uid)} --map-group=${String(ids.gid)} "$@"`
  return { command: 'unshare', args: ['--user', '--map-root-user', '--net', 'sh', '-c', `ip link set lo up && ${inner}`, 'sh', command, ...args] }
}

/**
 * The network interfaces this process can reach other than loopback.
 * @param interfaces - the interfaces, `os.networkInterfaces()` by default.
 * @returns their names.
 */
export function nonLoopbackInterfaces(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): readonly string[] {
  return Object.entries(interfaces).filter(([, addresses]) => (addresses ?? []).some(address => !address.internal)).map(([name]) => name)
}

/**
 * Check that this process runs in the isolated network: the re-run's variable is set and only loopback is up.
 * @param env - the environment.
 * @param interfaces - the interfaces.
 * @throws {IsolationRefusal} when another interface is present.
 */
export function assertIsolated(env: NodeJS.ProcessEnv = process.env, interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): void {
  if (env[ISOLATED_ENV] !== '1') throw new IsolationRefusal('the measured run must start inside the isolated network; run it through the benchmark command')
  const others = nonLoopbackInterfaces(interfaces)
  if (others.length > 0) throw new IsolationRefusal(`the run sees network interfaces other than loopback (${others.join(', ')}); refusing to measure where a request could leave the machine`)
}

/**
 * Re-run this command inside the isolated network and wait for it.
 * @param argv - the Node arguments of this process: the executable's options, the script and its arguments.
 * @returns the re-run's exit code.
 * @throws {IsolationRefusal} when `unshare` cannot create the namespaces.
 */
export async function rerunIsolated(argv: readonly string[]): Promise<number> {
  const { uid, gid } = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }
  const isolated = isolatedCommand(process.execPath, argv, { uid, gid })
  const child = spawn(isolated.command, [...isolated.args], { stdio: 'inherit', env: { ...process.env, [ISOLATED_ENV]: '1' } })
  return new Promise((resolve, reject) => {
    child.once('error', (error) => { reject(new IsolationRefusal(`unshare could not start (${error.message}); the benchmark needs unprivileged user and network namespaces`)) })
    child.once('exit', (code, signal) => { resolve(code ?? (signal === null ? 1 : 128)) })
  })
}
