/**
 * The network rules of a confined execution ({@link SandboxNetwork}) as the local runners express them. Only bwrap
 * can: `off` and `proxy` both start the command in a network namespace of its own, which holds a loopback interface
 * and nothing else. Under `proxy` the proxy's Unix socket is bound into the sandbox at its own path, and a small
 * bridge, run by the host's Node executable inside the sandbox before the command, listens on
 * {@link SANDBOX_PROXY_PORT} on that loopback interface and forwards each connection to the socket. The command's
 * proxy environment variables name that port, so a program that honours them reaches the proxy and one that ignores
 * them reaches nothing. The bridge detaches before the command starts, so the command keeps the wrap's exit status,
 * signals and descriptors; it ends with the sandbox's PID namespace when the command exits.
 *
 * Landlock, Seatbelt and the Windows ACL runner cannot express either rule here, so a wrap that asks for one is
 * refused rather than run with the host's network.
 *
 * @module @deepseek-ai/dsh-sandbox-local/network
 */

import type { SandboxNetwork } from '@deepseek-ai/dsh-sandbox'
import type { LocalSandboxRunner } from './profiles.ts'

/**
 * Which runners can confine a command's network. bwrap starts it in a network namespace of its own; the Landlock
 * launcher applies no network rule, Seatbelt's network rules are not built here, and the Windows ACL runner has none.
 */
export const RUNNER_NETWORK: Readonly<Record<LocalSandboxRunner, boolean>> = {
  bwrap: true,
  landlock: false,
  seatbelt: false,
  'windows-acl': false,
}

/**
 * The loopback port the bridge listens on inside the sandbox's own network namespace, where no other program has
 * bound it yet. A command that binds this port itself fails with `EADDRINUSE`.
 */
export const SANDBOX_PROXY_PORT = 3128

/** The prefix of every line the bridge writes to standard error, which consumers classify as a runner failure. */
export const BRIDGE_DIAGNOSTIC = 'sandbox-proxy-bridge: '

/** The proxy URL a confined command's environment names. */
const PROXY_URL = `http://127.0.0.1:${SANDBOX_PROXY_PORT}`

/**
 * The environment a `proxy` wrap sets inside the sandbox: the upper- and lower-case proxy variables most programs read,
 * the loopback names that bypass the proxy, and `NODE_USE_ENV_PROXY`, which makes Node's own HTTP clients honour them.
 */
export const PROXY_ENVIRONMENT: Readonly<Record<string, string>> = {
  HTTP_PROXY: PROXY_URL,
  HTTPS_PROXY: PROXY_URL,
  ALL_PROXY: PROXY_URL,
  http_proxy: PROXY_URL,
  https_proxy: PROXY_URL,
  all_proxy: PROXY_URL,
  NO_PROXY: 'localhost,127.0.0.1,::1',
  no_proxy: 'localhost,127.0.0.1,::1',
  NODE_USE_ENV_PROXY: '1',
}

/**
 * The bridge's forwarder, run detached: listen on the loopback port, print one line when listening, and copy each
 * connection to and from a new connection to the proxy's socket. Plain CommonJS for `node -e`, which every Node
 * accepts without a loader.
 */
const SERVE_SOURCE = `
const net = require('node:net')
const [socket, port] = process.argv.slice(1)
const fail = (error) => { process.stderr.write(${JSON.stringify(BRIDGE_DIAGNOSTIC)} + error.message + '\\n'); process.exit(1) }
const server = net.createServer({ allowHalfOpen: true }, (client) => {
  const upstream = net.connect({ path: socket, allowHalfOpen: true })
  const close = () => { client.destroy(); upstream.destroy() }
  client.on('error', close)
  upstream.on('error', close)
  client.pipe(upstream)
  upstream.pipe(client)
})
server.on('error', fail)
server.listen(Number(port), '127.0.0.1', () => { process.stdout.write('ready\\n') })
`

/**
 * The bridge's starter: start the forwarder detached, wait for its line, and exit 0 so the wrapping shell can `exec`
 * the command; exit 1 with a diagnostic when the forwarder fails before it listens.
 */
const START_SOURCE = `
const { spawn } = require('node:child_process')
const [socket, port] = process.argv.slice(1)
const fail = (message) => { process.stderr.write(${JSON.stringify(BRIDGE_DIAGNOSTIC)} + message + '\\n'); process.exit(1) }
const serve = spawn(process.execPath, ['-e', ${JSON.stringify(SERVE_SOURCE)}, '--', socket, port], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] })
serve.on('error', (error) => { fail(error.message) })
serve.on('exit', (code, signal) => { fail('the forwarder exited before it listened (' + (signal ?? code) + ')') })
serve.stdout.setEncoding('utf8')
let line = ''
serve.stdout.on('data', (chunk) => {
  line += chunk
  if (!line.includes('\\n')) return
  serve.removeAllListeners('exit')
  serve.stdout.destroy()
  serve.unref()
  process.exit(0)
})
`

/**
 * The shell program that starts the bridge and then replaces itself with the command. `ELECTRON_RUN_AS_NODE` makes an
 * Electron host's executable act as Node for the bridge alone; the command's environment does not carry it. When the
 * starter fails, including a Node executable the shell cannot run, the shell prints a {@link BRIDGE_DIAGNOSTIC} line
 * with its exit status and exits 1 without running the command, so the failure reads as the runner's, not the
 * command's.
 */
const WRAPPER = `ELECTRON_RUN_AS_NODE=1 "$1" -e "$2" -- "$3" "$4" || { printf '${BRIDGE_DIAGNOSTIC}the bridge did not start (exit status %s)\\n' "$?" >&2; exit 1; }; shift 4; exec "$@"`

/**
 * The argv that runs `argv` inside the sandbox behind the bridge to the proxy socket.
 * @param socket - the proxy's Unix socket, bound into the sandbox at this path.
 * @param argv - the caller's argv.
 * @param node - the Node executable that runs the bridge, readable inside the sandbox.
 * @returns the argv to place after the runner's `--`.
 */
export function bridgedArgv(socket: string, argv: readonly string[], node: string = process.execPath): string[] {
  return ['/bin/sh', '-c', WRAPPER, 'sh', node, START_SOURCE, socket, String(SANDBOX_PROXY_PORT), ...argv]
}

/**
 * The bwrap arguments that confine one execution's network: a network namespace of its own, and under `proxy` the
 * proxy environment. The socket's bind is placed by the profile builder, which knows the mounts it must follow.
 * @param network - the policy's network, or `undefined` or the `host` form for the host's network.
 * @returns the arguments, none for the host's network.
 */
export function bwrapNetworkArgs(network: SandboxNetwork | undefined): string[] {
  if (network === undefined || network.mode === 'host') return []
  const args = ['--unshare-net']
  if (network.mode === 'proxy') {
    for (const [name, value] of Object.entries(PROXY_ENVIRONMENT)) args.push('--setenv', name, value)
  }
  return args
}

/**
 * Why a runner refuses a policy's network, in words that name what to do.
 * @param runner - the selected runner, which cannot confine the network ({@link RUNNER_NETWORK}).
 * @param network - the requested network.
 * @returns the refusal's detail.
 */
export function networkRefusal(runner: LocalSandboxRunner, network: Exclude<SandboxNetwork, { readonly mode: 'host' }>): string {
  const wanted = network.mode === 'off' ? 'no network' : 'network through a proxy only'
  const fix = runner === 'windows-acl'
    ? 'the Windows sandbox has no per-command network rule'
    : runner === 'seatbelt'
      ? 'network rules are not built for the macOS sandbox'
      : 'the Landlock launcher applies no network rule; install bubblewrap so the sandbox can give commands a network of their own'
  return `the policy asks for ${wanted}, which the ${runner} sandbox cannot enforce (${fix}), so the command is refused rather than run with this computer's network; allow the network for this workspace to run it`
}
