/**
 * `delorun agents status` (`src/agents/status.ts`): the figures from a running Host or, without one, from the accounts
 * file; `--refresh` only through a running Host; and how windows read, including figures whose reset has passed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountsFilePath, readAccountsFile } from '@delorun/external-agents/accounts'
import type { ResponseLine, UnsignedRequest } from '@delorun/home-process'
import { createAgentsCommand, type AgentsDependencies } from '../src/agents/command.ts'
import { accountLines, planTitle, refreshLine, windowLine } from '../src/agents/status.ts'
import { CliError, EXIT } from '../src/exit.ts'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 17, 14, 0)
const UTC = { locale: 'en-GB', timeZone: 'UTC' }
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const CLAUDE = {
  provider: 'claude-code' as const, installed: true, signedIn: 'yes' as const, plan: 'max', checkedAt: NOW - HOUR,
  windows: [
    { kind: 'five_hour', usedPercent: 20.4, resetsAt: NOW + 2 * HOUR, status: 'allowed' as const, seenAt: NOW - HOUR, source: 'probe' as const },
    { kind: 'seven_day', usedPercent: 100, resetsAt: NOW + 30 * HOUR, status: 'reached' as const, seenAt: NOW - HOUR, source: 'run' as const },
  ],
}
const CODEX = { provider: 'codex' as const, installed: false, signedIn: 'unknown' as const, windows: [] }

/**
 * @param change - dependencies to replace.
 * @returns the command's run and output, with a fresh home.
 */
function command(change: Partial<AgentsDependencies> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ea1-limits-cli-'))
  roots.push(home)
  const out: string[] = []
  const sent: UnsignedRequest[] = []
  const dependencies: AgentsDependencies = {
    terminal: true, machine: { platform: 'linux', arch: 'x64' },
    find: agent => (agent === 'claude-code' ? { program: '/bundled/claude', args: ['auth', 'login'] } : undefined),
    run: () => Promise.resolve(0),
    running: () => true,
    send: async (_home, _profile, request) => {
      sent.push(request)
      if (request.op === 'agents.accounts') return [{ ok: true, accounts: [CLAUDE, CODEX], now: NOW }]
      return [{ ok: true, outcome: { kind: 'checked' }, record: CLAUDE, now: NOW }]
    },
    now: () => NOW,
    ...change,
  }
  const run = (args: string[]) => createAgentsCommand(dependencies).run(args, { env: { DELORUN_HOME: home, TZ: 'UTC', LANG: 'en_GB.UTF-8' }, stdout: text => out.push(text), stderr: () => {} })
  return { home, out, sent, run }
}

describe('delorun agents status --json', () => {
  it('prints the running Host\'s figures for every agent, and asks it to check nothing', async () => {
    const { run, out, sent } = command()
    await expect(run(['status', '--json'])).resolves.toBe(EXIT.ok)
    expect(JSON.parse(out.join(''))).toEqual({ source: 'host', now: NOW, accounts: [CLAUDE, CODEX] })
    expect(sent).toEqual([{ op: 'agents.accounts' }])
  })

  it('narrows to the agent named, and with --refresh asks the Host to check it first', async () => {
    const { run, out, sent } = command()
    await expect(run(['status', 'claude-code', '--refresh', '--json'])).resolves.toBe(EXIT.ok)
    expect(sent).toEqual([{ op: 'agents.refresh', args: { provider: 'claude-code', reason: 'check-now' } }, { op: 'agents.accounts' }])
    expect(JSON.parse(out.join(''))).toEqual({ source: 'host', now: NOW, accounts: [CLAUDE], refreshed: { 'claude-code': { kind: 'checked' } } })
  })

  it('reads the accounts file without a running Host, and says whether each agent is added', async () => {
    const { run, out, home } = command({ running: () => false, send: vi.fn() })
    const path = accountsFilePath(home)
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(path, JSON.stringify({ v: 1, accounts: { codex: { signedIn: 'no', windows: [] } } }), { mode: 0o600 })
    await expect(run(['status', '--json'])).resolves.toBe(EXIT.ok)
    expect(JSON.parse(out.join(''))).toEqual({
      source: 'file', now: NOW,
      accounts: [{ provider: 'claude-code', installed: true, signedIn: 'unknown', windows: [] }, { provider: 'codex', installed: false, signedIn: 'no', windows: [] }],
    })
  })

  it('falls back to the file when the running profile does not load external agents', async () => {
    const { run, out } = command({ send: () => Promise.resolve([{ ok: false, error: 'AGENTS_UNAVAILABLE', detail: 'x' }]) })
    await expect(run(['status', '--json'])).resolves.toBe(EXIT.ok)
    expect(JSON.parse(out.join(''))).toMatchObject({ source: 'host', accounts: [{ provider: 'claude-code', signedIn: 'unknown' }, { provider: 'codex' }] })
  })
})

describe('delorun agents status', () => {
  it('says to start Delorun for --refresh without a running Host, and starts nothing', async () => {
    const send = vi.fn()
    const { run } = command({ running: () => false, send })
    const error: unknown = await run(['status', '--refresh']).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({ exit: EXIT.notRunning, message: expect.stringContaining('Start it with: delorun start') })
    expect(send).not.toHaveBeenCalled()
  })

  it('fails on a check that did not answer, after printing the figures', async () => {
    const { run, out } = command({
      send: async (_home, _profile, request) => (request.op === 'agents.refresh'
        ? [{ ok: true, outcome: { kind: 'failed', problem: 'the program exited' }, record: CODEX, now: NOW }]
        : [{ ok: true, accounts: [CLAUDE, CODEX], now: NOW }]),
    })
    await expect(run(['status', 'codex', '--refresh'])).resolves.toBe(EXIT.failed)
    expect(out.join('')).toContain('The Codex check did not answer (the program exited).')
  })

  it.each<[string, readonly ResponseLine[]]>([
    ['a refusal', [{ ok: false, error: 'SCHEMA_VIOLATION', detail: 'bad' }]],
    ['figures it cannot read', [{ ok: true, accounts: 'nope' }]],
    ['no answer', []],
  ])('fails on %s from the Host', async (_name, lines) => {
    const { run } = command({ send: () => Promise.resolve(lines) })
    await expect(run(['status'])).rejects.toMatchObject({ exit: EXIT.failed })
  })

  it('fails on a refresh the Host refused or answered unreadably', async () => {
    for (const line of [{ ok: false, error: 'LOOPBACK_REQUIRED' }, { ok: true, outcome: { kind: 'odd' } }]) {
      const { run } = command({ send: () => Promise.resolve([line]) })
      await expect(run(['status', 'codex', '--refresh'])).rejects.toMatchObject({ exit: EXIT.failed })
    }
  })

  it.each([[['status', 'gemini']], [['status', 'codex', 'extra']], [['login', 'codex', '--json']], [['help']]])('is a usage error for %j', async (args) => {
    const { run } = command()
    await expect(run(args)).rejects.toMatchObject({ exit: EXIT.usage })
  })
})

describe('the printed figures', () => {
  it('name each window, its share, its reset and when it was seen', () => {
    expect(accountLines(CLAUDE, NOW, UTC)).toEqual([
      'Claude Code: signed in · Max plan',
      '  5-hour limit: 20% used, resets 17 Nov 2026, 16:00 (as of 17 Nov 2026, 13:00)',
      '  Weekly limit: limit reached (100% used), until 18 Nov 2026, 20:00 (as of 17 Nov 2026, 13:00)',
      '  Last checked 17 Nov 2026, 13:00.',
    ])
  })

  it('say a window whose reset passed was not checked since, and never call it reached', () => {
    const line = windowLine({ kind: 'five_hour', usedPercent: 100, resetsAt: NOW - HOUR, status: 'reached', seenAt: NOW - 3 * HOUR, source: 'run' }, NOW, UTC)
    expect(line).toBe('5-hour limit: reset at 17 Nov 2026, 13:00, not checked since (100% used, as of 17 Nov 2026, 11:00)')
  })

  it('read an agent not added, signed out, not yet known, and a failed last check', () => {
    expect(accountLines(CODEX, NOW, UTC)).toEqual(['Codex: not added. Add it in the Agents step of setup or in Plugins.'])
    expect(accountLines({ ...CODEX, installed: true, signedIn: 'no' }, NOW, UTC)).toEqual([
      'Codex: signed out. Sign in with: delorun agents login codex',
      '  No limit figures yet. Check now: delorun agents status codex --refresh',
    ])
    expect(accountLines({ ...CODEX, installed: true, plan: 'plus', checkedAt: 1, checkFailedAt: NOW }, NOW, UTC)).toEqual([
      'Codex: sign-in not known yet · Plus plan',
      '  No limit figures yet. Check now: delorun agents status codex --refresh',
      '  Last checked 1 Jan 1970, 00:00.',
      '  The last check, 17 Nov 2026, 14:00, did not answer; the figures are as last seen.',
    ])
    expect(windowLine({ kind: 'window_90m', status: 'near', seenAt: NOW, source: 'run' }, NOW, UTC)).toBe('90-minute limit: near the limit (as of 17 Nov 2026, 14:00)')
    expect(windowLine({ kind: 'seven_day_opus', status: 'unknown', seenAt: NOW, source: 'run' }, NOW, UTC)).toBe('Weekly Opus limit: no figures (as of 17 Nov 2026, 14:00)')
    expect(windowLine({ kind: 'monthly_credits', usedPercent: 3, status: 'allowed', seenAt: NOW, source: 'run' }, NOW, UTC)).toBe('Monthly credits limit: 3% used (as of 17 Nov 2026, 14:00)')
  })

  it('word each refresh outcome and plan name', () => {
    expect(refreshLine('codex', { kind: 'throttled', nextAt: NOW }, UTC)).toBe('Codex was checked a short while ago; the next check can run at 17 Nov 2026, 14:00.')
    expect(refreshLine('codex', { kind: 'not-installed' })).toBe('Codex is not added, so nothing was checked.')
    expect(refreshLine('claude-code', { kind: 'refused', problem: 'Four agents are running.' })).toBe('The Claude Code check did not start: Four agents are running.')
    expect(planTitle('chatgpt_plus')).toBe('Chatgpt plus')
  })
})

describe('delorun agents login, then a check', () => {
  it('asks a running Host to check the agent after a sign-in that ended well', async () => {
    const { run, out, sent } = command()
    await expect(run(['login', 'claude-code'])).resolves.toBe(EXIT.ok)
    expect(sent).toEqual([{ op: 'agents.refresh', args: { provider: 'claude-code', reason: 'signed-in' } }])
    expect(out.join('')).toContain('Signed in. Checked Claude Code now. See the figures with: delorun agents status claude-code')
  })

  it('leaves a check mark for the next start without a running Host, and sends nothing', async () => {
    const send = vi.fn()
    const { run, out, home } = command({ running: () => false, send })
    await expect(run(['login', 'claude-code'])).resolves.toBe(EXIT.ok)
    expect(send).not.toHaveBeenCalled()
    expect(out.join('')).toContain('Delorun checks Claude Code\'s plan limits when it next starts')
    // Pins D17: the CLI starts no check; it leaves the mark the Host's next start uses once.
    const read = await readAccountsFile(accountsFilePath(home))
    expect(read).toEqual({ kind: 'readable', file: { v: 1, accounts: { 'claude-code': { signedIn: 'unknown', windows: [], checkRequestedAt: NOW } } } })
  })

  it('keeps the sign-in when the check cannot be asked for, and says how to check', async () => {
    for (const send of [() => Promise.reject(new Error('socket gone')), () => Promise.resolve([{ ok: false, error: 'AGENTS_UNAVAILABLE' }])]) {
      const { run, out } = command({ send })
      await expect(run(['login', 'claude-code'])).resolves.toBe(EXIT.ok)
      expect(out.join('')).toContain('Delorun did not check the plan limits now; check them with: delorun agents status claude-code --refresh')
    }
  })

  it('says how to check when the mark cannot be left', async () => {
    const { run, out, home } = command({ running: () => false })
    writeFileSync(join(home, 'secrets'), 'a file where the folder should be')
    await expect(run(['login', 'claude-code'])).resolves.toBe(EXIT.ok)
    expect(out.join('')).toContain('Signed in. Start Delorun, then check the plan limits with: delorun agents status claude-code --refresh')
  })

  it('sends no check after a sign-in that failed', async () => {
    const { run, sent } = command({ run: () => Promise.resolve(1) })
    await expect(run(['login', 'claude-code'])).rejects.toMatchObject({ exit: EXIT.failed })
    expect(sent).toEqual([])
  })
})
