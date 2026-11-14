/**
 * Test-only start driver: runs `delorun start --foreground` for the CLI profile
 * `default` with upstream's real profile preparation and runner, the Web
 * application listening on an OS-assigned port, then prints one JSON line and
 * exits. The line holds the outcome, each row's id and state, and the
 * `enabled` setting of upstream's `session-log-deepseek` row as the booted
 * Loader holds it, read before a refusal shuts the application down.
 *
 * With `--probe-confinement`, the started profile's own sandbox provider
 * confines a workspace command that tries to read a file under the Delorun home
 * and the start token and to send `status` on the update channel; the line
 * then also holds that command's outcome, and the same command's outcome
 * unconfined.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { startTokenFile } from '@delorun/home'
import { updateSocketPath } from '@delorun/home-process'
import { prepareHome } from '../../src/command.ts'
import { CliError } from '../../src/exit.ts'
import type {} from '@delorun/bundle-local/update-gate'
import { bootedRows, serviceProvider, startForeground, upstreamDependencies, type BootedProfile } from '../../src/start.ts'
import { configSchemasOf, settleSecretValues } from '../../src/secret-fields.ts'

const context = {
  env: { ...process.env },
  stdout: (text: string) => void process.stderr.write(text),
  stderr: (text: string) => void process.stderr.write(text),
}
const upstream = upstreamDependencies()
let booted: BootedProfile | undefined
let root: Context | undefined
let rowsAtBoot: unknown[] = []
let sessionLogEnabled: unknown
const { home, profile } = await prepareHome(context, undefined)
const report = (outcome: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ ...outcome, rows: rowsAtBoot, sessionLogEnabled })}\n`)
}

/**
 * The workspace command: it reads a file under the home and the start token, and sends `status` with what it read.
 * It prints only the outcome of each step, never the token.
 */
const ATTEMPT = `
const fs = require('node:fs'), net = require('node:net')
const [fixture, tokenFile, socket] = process.argv.slice(1)
const tryRead = path => { try { return { ok: true, text: fs.readFileSync(path, 'utf8') } } catch (error) { return { ok: false, code: error.code || 'error' } } }
const fixtureRead = tryRead(fixture), tokenRead = tryRead(tokenFile)
const out = { home: fixtureRead.ok ? 'ok' : fixtureRead.code, token: tokenRead.ok ? 'ok' : tokenRead.code }
const connection = net.connect(socket)
let text = ''
connection.on('connect', () => { connection.write(JSON.stringify({ v: 1, token: tokenRead.ok ? tokenRead.text.trim() : undefined, op: 'status' }) + '\\n') })
connection.on('data', chunk => { text += chunk })
connection.on('error', error => { console.log(JSON.stringify({ ...out, connect: error.code || 'error' })); process.exit(0) })
connection.on('close', () => { if (text !== '') { const { ok, error } = JSON.parse(text.split('\\n')[0]); console.log(JSON.stringify({ ...out, connect: 'ok', answer: ok ? 'ok' : error })) } })
`

/**
 * Run the workspace command under the started profile's sandbox provider, and unconfined.
 * @param ctx - the booted root context.
 * @returns both outcomes.
 */
async function probeConfinement(ctx: Context): Promise<Record<string, unknown>> {
  const run = promisify(execFile)
  const fixture = join(home.path, 'secrets', 'probe-fixture')
  writeFileSync(fixture, 'fixture\n', { mode: 0o600 })
  const workspace = join(process.cwd(), 'workspace')
  mkdirSync(workspace, { recursive: true })
  const argv = [process.execPath, '-e', ATTEMPT, fixture, startTokenFile(home.path, profile), updateSocketPath(home.path, profile)]
  const sandbox = ctx.get('sandbox')
  if (sandbox === undefined) return { confinement: 'no sandbox provider' }
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: workspace }
  const confined = await sandbox.confine(argv, policy)
  const attempt = async (command: readonly string[]): Promise<unknown> => JSON.parse((await run(command[0] ?? '', command.slice(1), { encoding: 'utf8', timeout: 30_000 })).stdout.trim())
  // Where an escape directory exists, bwrap is started from a shell that hands it the escape filter.
  const runner = confined.argv.includes('bwrap') ? 'bwrap' : confined.argv[0]
  return { runner, confined: await attempt(confined.argv), unconfined: await attempt(argv) }
}

try {
  await startForeground({ home: home.path, profile, open: false, output: context, env: context.env }, {
    ...upstream,
    async runProfile(options) {
      const { runProfile } = await import('@deepseek-ai/dsh/profile-boot')
      const { ctx, shutdown } = await runProfile({ ...options, args: [...options.args, '--port', '0'] })
      root = ctx
      const row = [...ctx.get('loader')?.entries() ?? []].find(entry => entry.options.id === 'session-log-deepseek')
      sessionLogEnabled = (row?.options.config as { enabled?: unknown } | undefined)?.enabled
      const profile: BootedProfile = { configSchemas: configSchemasOf(ctx), settleSecretValues: (home, profile) => settleSecretValues(ctx, home, profile, configSchemasOf(ctx)), rows: () => (rowsAtBoot = bootedRows(ctx)), providerOf: name => serviceProvider(ctx, name), releaseTurns: () => { ctx.get('delorunTurnGate')?.release() }, shutdown: code => shutdown.shutdown(code), dispose: async () => { await ctx.fiber.dispose() }, watchChats: () => {}, watchUpdates: () => Promise.resolve(), studio: () => undefined, studioLink: () => ({ kind: 'unavailable', reason: 'the Host serves no studio' }), reload: async () => Promise.resolve({ ok: true }) }
      booted = profile
      return profile
    },
  })
  const confinement = process.argv.includes('--probe-confinement') && root !== undefined ? await probeConfinement(root) : {}
  report({ outcome: 'started', ...confinement })
  await booted?.shutdown(0)
  process.exit(0)
} catch (error) {
  report({ outcome: 'refused', message: error instanceof CliError ? error.message : String(error) })
  process.exit(1)
}
