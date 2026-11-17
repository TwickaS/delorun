/**
 * The owner-attended proof of the browse driver (step 0 of the use-my-browser plan): on a scratch Delorun home, it runs
 * the pinned `browse mcp` through a plain `@deepseek-ai/dsh-mcp-client` row, the client Delorun uses, and records what
 * the relay offers that client and what one `execute` call does. Nothing starts before the person at the computer types
 * `go` at the step that starts it, and `--plan` prints the steps without starting anything.
 *
 * The first browse call starts browse's relay, which listens on 127.0.0.1:19988 (or 19990–19997), outlives this script
 * and talks to whichever browser profile is paired with it. Run it only with the browser's owner present.
 *
 * Usage: `node_modules/.bin/tsx delorun/packages/browser-use-browse/scripts/proof.ts [--plan] [--wsl-relay windows|linux]`
 * - `--wsl-relay linux` (W1): the pinned Linux binary; the relay runs in WSL and needs its own pairing.
 * - `--wsl-relay windows` (W3): the pinned windows-x64 binary through WSL interop, fetched from npm and checked against
 *   the lockfile's integrity; the relay runs on Windows beside any existing pairing there.
 * @module
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { binaryIn, childEnv, Config, resolveCommand } from '../src/config.ts'

/** The pinned version, as the package's dependency names it. */
const PINNED = '0.1.1'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

/** What the run observed, written to the scratch folder as it goes. */
interface Observations {
  readonly started: string
  mode: string
  binary?: string
  version?: string
  server?: unknown
  tools?: unknown
  status?: unknown
  tabs?: unknown
  execute?: unknown
  notes: string[]
}

const args = process.argv.slice(2)
const planOnly = args.includes('--plan')
const wslRelay = args[args.indexOf('--wsl-relay') + 1]
const isWsl = process.platform === 'linux' && /microsoft/iu.test(readFileSync('/proc/version', 'utf8'))
if (args.includes('--wsl-relay') && wslRelay !== 'windows' && wslRelay !== 'linux') {
  throw new Error('--wsl-relay takes windows or linux')
}
const mode = isWsl ? (wslRelay === 'windows' ? 'W3 (pinned windows-x64 through interop)' : 'W1 (pinned Linux binary, relay in WSL)') : `${process.platform}-${process.arch}`

const STEPS = [
  `1. Make a scratch Delorun home under ${tmpdir()} and resolve the pinned browse ${PINNED} binary (${mode}).`,
  '2. Print the binary\'s --version. Nothing else starts.',
  '3. Start `browse mcp` through a plain dsh-mcp-client row with Delorun\'s environment (inherited OPENCODE_BROWSER_* blanked, updates off) and list its tools. Listing probes the relay ports for a running relay; it starts none.',
  '4. Call `status`. This starts browse\'s relay if none runs (127.0.0.1:19988, detached, stops after 30 idle minutes) and reports its version, who started it and whether a browser is paired.',
  '5. If no browser is paired: pair it now in another terminal with the printed command, then continue.',
  '6. Call `tabs`, then one `execute` call with the code you type (a suggestion is printed), in a tab browse opens.',
  '7. Close the client and write the observations file; the relay keeps running until it is idle.',
]

/**
 * Wait for the attendee to type `go`; anything else stops the run.
 * @param question - what the next step does.
 */
async function confirm(prompt: ReturnType<typeof createInterface>, question: string): Promise<void> {
  const answer = (await prompt.question(`\n${question}\nType go to continue, anything else to stop: `)).trim()
  if (answer !== 'go') throw new Error('stopped by the attendee before this step')
}

/**
 * The lockfile's sha512 integrity of one pinned package.
 * @param name - the package name.
 * @returns the integrity string.
 */
function lockIntegrity(name: string): string {
  const lock = readFileSync(join(REPO, 'pnpm-lock.yaml'), 'utf8')
  const match = new RegExp(`'${name.replace(/[/@.-]/gu, '\\$&')}@${PINNED.replace(/\./gu, '\\.')}':\\n\\s+resolution: \\{integrity: (sha512-[^}]+)\\}`, 'u').exec(lock)
  if (match?.[1] === undefined) throw new Error(`pnpm-lock.yaml pins no ${name}@${PINNED}`)
  return match[1]
}

/**
 * Fetch the windows-x64 package with npm, check it against the lockfile and unpack it.
 * @param scratch - the scratch folder.
 * @returns the unpacked package's folder.
 */
function fetchWindowsPackage(scratch: string): string {
  const name = '@opencode/browse-windows-x64'
  const into = join(scratch, 'npm-pack')
  mkdirSync(into)
  execFileSync('npm', ['pack', `${name}@${PINNED}`, '--silent', '--pack-destination', into], { stdio: ['ignore', 'pipe', 'inherit'] })
  const tarball = readdirSync(into).find(file => file.endsWith('.tgz'))
  if (tarball === undefined) throw new Error(`npm pack wrote no tarball for ${name}`)
  const bytes = readFileSync(join(into, tarball))
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  const expected = lockIntegrity(name)
  if (actual !== expected) throw new Error(`${name}@${PINNED} does not match the lockfile: ${actual} is not ${expected}`)
  execFileSync('tar', ['-xzf', join(into, tarball), '-C', into])
  const directory = join(into, 'package')
  chmodSync(binaryIn(directory, 'windows-x64'), 0o755)
  return directory
}

/**
 * Run one browse tool through the tool runtime, as a chat's call would run.
 * @param ctx - the context holding the client.
 * @param tool - the tool's name without the server prefix.
 * @param input - its arguments.
 * @returns the result the runtime produced.
 */
async function call(ctx: Context, tool: string, input: object): Promise<unknown> {
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: ToolCallId(`proof-${tool}`), name: `mcp__browse__${tool}`, arguments: JSON.stringify(input) }],
    signal: AbortSignal.timeout(120_000),
  })
  return batch.results[0]?.result
}

/** Print a labelled value. */
function show(label: string, value: unknown): void {
  console.log(`\n--- ${label} ---\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)
}

console.log(`browse driver proof, ${mode}\n\n${STEPS.join('\n')}`)
if (planOnly) process.exit(0)

const prompt = createInterface({ input: process.stdin, output: process.stdout })
const scratch = mkdtempSync(join(tmpdir(), 'delorun-browse-proof-'))
const observations: Observations = { started: new Date().toISOString(), mode, notes: [] }
const record = (): void => { writeFileSync(join(scratch, 'observations.json'), `${JSON.stringify(observations, null, 2)}\n`) }
const ctx = new Context()
try {
  await confirm(prompt, `Step 1 makes ${scratch}/home${wslRelay === 'windows' ? ' and fetches the windows-x64 package from npm' : ''}.`)
  const home = join(scratch, 'home')
  mkdirSync(home, { mode: 0o700 })
  const config = Config({ variant: wslRelay === 'windows' ? 'windows-x64' : 'auto' })
  const command = wslRelay === 'windows'
    ? resolveCommand(config, undefined, (variant) => (variant === 'windows-x64' ? fetchWindowsPackage(scratch) : undefined))
    : resolveCommand(config)
  observations.binary = command.command
  show('binary', command.command)
  record()

  await confirm(prompt, 'Step 2 runs the binary with --version.')
  observations.version = execFileSync(command.command, ['--version'], { encoding: 'utf8', env: { ...process.env, ...childEnv(config) } }).trim()
  show('version', observations.version)
  if (!observations.version.includes(PINNED)) observations.notes.push(`--version does not name ${PINNED}`)
  record()

  await confirm(prompt, 'Step 3 starts `browse mcp` and lists its tools; no relay starts.')
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(McpClient, McpClient.Config({
    transport: 'stdio',
    serverName: 'browse',
    command: command.command,
    args: [...command.args],
    env: childEnv(config),
    cwd: home,
    failOnStartupError: true,
    reconnect: { enabled: false },
  }))
  observations.tools = ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__browse__')).map(tool => ({ name: tool.name, description: tool.description }))
  show('tools', observations.tools)
  record()

  await confirm(prompt, 'Step 4 calls status, which starts browse\'s relay if none runs.')
  observations.status = await call(ctx, 'status', {})
  show('status', observations.status)
  record()

  await confirm(prompt, `Step 5: if status shows no paired browser, pair one now in another terminal with:\n  ${command.command} pair\nand follow its instructions in the browser. Type go once paired (or if it already was).`)
  observations.tabs = await call(ctx, 'tabs', {})
  show('tabs', observations.tabs)
  record()

  const executeSchema = ctx.tools.schemas().find(tool => tool.name === 'mcp__browse__execute')
  const required = (executeSchema?.parameters as { required?: readonly string[] } | undefined)?.required
  const field = required?.[0]
  if (field === undefined) throw new Error('browse offers no execute tool with a required argument to this client')
  // A guess at browse's script API; the attendee checks it against execute's description printed in step 3.
  const suggestion = 'await page.goto("https://example.com"); return await page.title()'
  const code = (await prompt.question(`\nStep 6: the ${field} for execute (Enter for this guess, checked against its description above):\n  ${suggestion}\n> `)).trim() || suggestion
  await confirm(prompt, `Step 6 runs execute with ${field}:\n  ${code}`)
  observations.execute = { field, code, result: await call(ctx, 'execute', { [field]: code }) }
  show('execute', observations.execute)
  const note = (await prompt.question('\nAnything the attendee saw in the browser (Enter for nothing): ')).trim()
  if (note !== '') observations.notes.push(note)
  record()
} finally {
  prompt.close()
  await ctx.fiber.dispose()
  record()
  console.log(`\nObservations: ${join(scratch, 'observations.json')}\nThe relay, if it started, keeps running until it has been idle for 30 minutes.`)
}
