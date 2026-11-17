/**
 * The terminal chapter's output, made by the product: a temporary home whose `home-default` log is written by the real
 * `SurfaceLog` with the two records the home process writes on a normal start, then read by the CLI's own `runLogs`.
 * The output is compared with the committed `changes-and-versions.terminal.json`, which the replica draws. The home
 * path is replaced by `~/.delorun`. When the CLI's output or the home process's records change, the file is stale and
 * this spec names the command that rewrites it: `REPLICA_TERMINAL_WRITE=1 node_modules/.bin/vitest run --config
 * delorun/vitest.config.ts --project fork delorun/apps/website/tests/product/replica-terminal.spec.ts`.
 * @module @delorun/website/tests/product/replica-terminal.spec
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runLogs, type LogsIo } from '../../../cli/src/logs/index.ts'
import { Redactor, resolveSurface, SurfaceLog } from '../../../../packages/logs/src/index.ts'

const COMMAND = 'delorun logs'
const RUNTIME = '0.1.0-preview.2'
/** The home process's logger name (`HOME_LOGGER` in `packages/home-process/src/log.ts`). */
const HOME_LOGGER = 'home-process'
/** The home starts at this moment; the fixture's clock is 2026-11-17T10:50:00Z. */
const STARTED = Date.parse('2026-11-17T09:30:00.000Z')
const OUTPUT_FILE = resolve(import.meta.dirname, '../../src/replica/sessions/changes-and-versions.terminal.json')
const REGENERATE = 'REPLICA_TERMINAL_WRITE=1 node_modules/.bin/vitest run --config delorun/vitest.config.ts --project fork delorun/apps/website/tests/product/replica-terminal.spec.ts'

let home: string | undefined
afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
})

/**
 * Write the records of a normal start of the home process, with its supervisor not launched, and run `delorun logs`.
 * @returns the command's standard output with the temporary home shown as `~/.delorun`, one entry per line.
 */
async function realOutput(): Promise<readonly string[]> {
  const root = mkdtempSync(join(tmpdir(), 'delorun-replica-terminal-'))
  home = root
  const clock = { now: STARTED }
  const log = SurfaceLog.open({
    location: resolveSurface({ kind: 'home', home: root, profile: 'default' }),
    redactor: new Redactor(),
    pid: 4242,
    level: 'info',
    startId: 'replica-terminal-start',
    onFailure: (error) => { throw error },
    now: () => clock.now,
  })
  const logger = log.logger(HOME_LOGGER)
  // `listenUpdateChannel` has returned (`HomeProcess.listenUpdates`).
  clock.now += 400
  logger.info('update channel listening')
  // `enterRunning`, with no supervisor launched.
  clock.now += 1200
  logger.info('running', { data: { runtime: RUNTIME, supervisor: 'not launched' } })
  log.close()
  let out = ''
  const io: LogsIo = {
    home: root,
    profile: 'default',
    stdout: (text) => { out += text },
    stderr: (text) => { throw new Error(`delorun logs wrote to standard error: ${text}`) },
    confirm: () => Promise.resolve(false),
    now: () => clock.now,
    signal: new AbortController().signal,
  }
  expect(await runLogs([], io)).toBe(0)
  const lines = out.split(root).join('~/.delorun').split('\n')
  expect(lines.at(-1)).toBe('')
  return lines.slice(0, -1)
}

describe('the replica terminal output', () => {
  it('is what delorun logs prints for the home process\'s records of a normal start', async () => {
    const written = { command: COMMAND, output: await realOutput() }
    const text = `${JSON.stringify(written, null, 2)}\n`
    if (process.env['REPLICA_TERMINAL_WRITE'] === '1') {
      writeFileSync(OUTPUT_FILE, text)
      return
    }
    expect(readFileSync(OUTPUT_FILE, 'utf8'), `changes-and-versions.terminal.json is stale; rewrite it with: ${REGENERATE}`).toBe(text)
  })
})
