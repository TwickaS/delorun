/**
 * The real limits check of one agent, for a live run: the real driver behind the start gate, the account service over a
 * scratch home, one "Check now", and the store file it wrote. The program signs in with the person's own sign-in, found
 * where it finds it (`CLAUDE_CONFIG_DIR` or `CODEX_HOME` as already set); nothing here reads, copies or prints a
 * credential, and no model request is made. Prints the store's field names and the check's outcome, never a value
 * that could name the person. Never part of a Vitest lane.
 * @module @delorun/external-agents/live/limits-check
 */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { accountsFilePath, checkThrough, createAgentAccounts } from '../src/accounts/index.ts'
import type { ExternalAgentDriver } from '../src/contract.ts'
import { ExternalAgentsService } from '../src/gate.ts'

/** The fields an account's stored entry may hold, and a window's, and a model's. */
const ACCOUNT_FIELDS = new Set(['signedIn', 'plan', 'windows', 'offeredModels', 'checkedAt', 'checkFailedAt', 'checkRequestedAt'])
const WINDOW_FIELDS = new Set(['kind', 'usedPercent', 'resetsAt', 'status', 'seenAt', 'source'])
const MODEL_FIELDS = new Set(['id', 'displayName', 'isDefault'])

/**
 * Names the keys of an object that are not in an allowed set.
 * @param value - an object.
 * @param allowed - the allowed keys.
 * @returns the other keys.
 */
function stray(value: unknown, allowed: ReadonlySet<string>): string[] {
  return typeof value === 'object' && value !== null ? Object.keys(value).filter(key => !allowed.has(key)) : []
}

/**
 * Check one agent through the gate and report what the store holds.
 * @param driver - the real driver.
 * @returns the process exit code: 0 when the check observed the account and the file holds only allowed fields.
 */
export async function runLimitsCheck(driver: ExternalAgentDriver): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), 'ea-int-limits-'))
  chmodSync(home, 0o700)
  const ctx = new Context()
  try {
    await ctx.plugin(LocalSubprocessRuntime)
    ctx.inject(['subprocess'], (scope) => {
      scope.plugin(ExternalAgentsService, {
        maxLivePrograms: 2, graceMs: 3_000, limitRefusal: false, env: process.env, now: Date.now,
        probeFolder: () => Promise.resolve(mkdtempSync(join(tmpdir(), 'ea-int-probe-'))),
        programRecords: undefined, processTable: undefined, programExecutables: () => [], programScripts: () => [],
      })
    })
    await new Promise<void>((resolve) => { const check = (): void => { if (ctx.get('externalAgents') === undefined) setTimeout(check, 20); else resolve() }; check() })
    ctx.externalAgents.registerDriver(driver)
    const accounts = createAgentAccounts({
      storePath: accountsFilePath(home), now: Date.now, probeMinIntervalMs: () => 60_000, triggers: () => ['check-now'],
      installed: provider => ctx.externalAgents.hasDriver(provider), check: checkThrough(ctx.externalAgents),
      report: message => { console.error(`report: ${message}`) }, signal: AbortSignal.timeout(120_000),
    })
    const answer = await accounts.refresh(driver.provider, 'check-now')
    console.log(`outcome: ${answer.outcome.kind}`)
    if ('problem' in answer.outcome) console.log(`problem: ${answer.outcome.problem.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>').slice(0, 300)}`)
    const file = accountsFilePath(home)
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { v: unknown, accounts?: Record<string, Record<string, unknown>> }
    const entry = stored.accounts?.[driver.provider]
    const problems = [
      ...Object.keys(stored).filter(key => key !== 'v' && key !== 'accounts').map(key => `file field ${key}`),
      ...Object.keys(stored.accounts ?? {}).filter(key => key !== driver.provider).map(key => `provider ${key}`),
      ...stray(entry, ACCOUNT_FIELDS).map(key => `account field ${key}`),
      ...(Array.isArray(entry?.['windows']) ? entry['windows'] : []).flatMap(window => stray(window, WINDOW_FIELDS).map(key => `window field ${key}`)),
      ...(Array.isArray(entry?.['offeredModels']) ? entry['offeredModels'] : []).flatMap(model => stray(model, MODEL_FIELDS).map(key => `model field ${key}`)),
    ]
    console.log(`stored: v=${String(stored.v)} account fields=${Object.keys(entry ?? {}).sort().join(',')}`)
    console.log(`signedIn: ${String(entry?.['signedIn'])}; windows: ${Array.isArray(entry?.['windows']) ? entry['windows'].map(window => `${String((window as { kind: unknown }).kind)}=${String((window as { status: unknown }).status)}`).join(',') : 'none'}`)
    console.log(problems.length === 0 ? 'fields: only the allowed ones' : `fields: NOT ALLOWED ${problems.join('; ')}`)
    if (problems.length === 0 && answer.outcome.kind === 'checked') {
      const out = join(homedir(), 'delorun-rc-release', 'ea1-limits')
      mkdirSync(out, { recursive: true })
      copyFileSync(file, join(out, `${driver.provider}-accounts.json`))
      console.log(`copied to ${out}/${driver.provider}-accounts.json`)
      return 0
    }
    return 1
  } finally {
    await ctx.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  }
}
