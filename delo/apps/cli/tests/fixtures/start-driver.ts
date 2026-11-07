/**
 * Test-only start driver: runs `delorun start --foreground` for the CLI profile
 * `default` with upstream's real profile preparation and runner, the Web
 * application listening on an OS-assigned port, then prints one JSON line and
 * exits. The line holds the outcome, each row's id and state, and the
 * `enabled` setting of upstream's `session-log-deepseek` row as the booted
 * Loader holds it, read before a refusal shuts the application down.
 */
import { prepareHome } from '../../src/command.ts'
import { CliError } from '../../src/exit.ts'
import { bootedRows, startForeground, upstreamDependencies, type BootedProfile } from '../../src/start.ts'

const context = {
  env: { ...process.env },
  stdout: (text: string) => void process.stderr.write(text),
  stderr: (text: string) => void process.stderr.write(text),
}
const upstream = upstreamDependencies()
let booted: BootedProfile | undefined
let rowsAtBoot: unknown[] = []
let sessionLogEnabled: unknown
const { home, profile } = await prepareHome(context, undefined)
const report = (outcome: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ ...outcome, rows: rowsAtBoot, sessionLogEnabled })}\n`)
}
try {
  await startForeground({ home: home.path, profile, open: false, output: context }, {
    ...upstream,
    async runProfile(options) {
      const { runProfile } = await import('@deepseek-ai/dsh/profile-boot')
      const { ctx, shutdown } = await runProfile({ ...options, args: [...options.args, '--port', '0'] })
      const row = [...ctx.get('loader')?.entries() ?? []].find(entry => entry.options.id === 'session-log-deepseek')
      sessionLogEnabled = (row?.options.config as { enabled?: unknown } | undefined)?.enabled
      booted = { rows: () => (rowsAtBoot = bootedRows(ctx)), shutdown: code => shutdown.shutdown(code) }
      return booted
    },
  })
  report({ outcome: 'started' })
  await booted?.shutdown(0)
  process.exit(0)
} catch (error) {
  report({ outcome: 'refused', message: error instanceof CliError ? error.message : String(error) })
  process.exit(1)
}
