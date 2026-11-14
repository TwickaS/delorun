/**
 * The one ordered list of steps before a Host boots (`delorun/apps/cli/src/pre-start.ts`): its order, which start runs
 * which step, a successor that makes no one-time change, and a refusing step that stops the rest.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { preStartSteps, recoverStockImportStep, runPreStartSteps, updateNoticeStep, type PreStartContext, type PreStartStep } from '../src/pre-start.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'delorun-pre-start-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/**
 * A start's context.
 * @param kind - the start.
 * @param successor - whether it is an update's successor.
 * @returns the context.
 */
function context(kind: PreStartContext['kind'], successor = false): PreStartContext {
  return { home, profile: kind === 'cli' ? 'default' : 'headless', kind, successor, output: { stdout: () => undefined, stderr: () => undefined } }
}

/**
 * The real list with each step replaced by one that records its name, keeping its kinds.
 * @param ran - collects the names.
 * @param migrated - collects the starts whose migrations were asked for.
 * @returns the steps.
 */
function recorded(ran: string[], migrated: PreStartContext[]): PreStartStep[] {
  return preStartSteps({ migrations: (start) => { migrated.push(start); return [] }, pluginChanges: () => Promise.resolve() }).map(step => ({
    ...step,
    run: async (start: PreStartContext) => {
      ran.push(step.name)
      if (step.name === 'profile-migrations') await step.run(start)
    },
  }))
}

describe('the pre-start steps', () => {
  it('run in one order: the import recovery, the restore recovery, the data-format record, the migrations, Changes, the plugin change check, then the update notice', () => {
    expect(preStartSteps({ migrations: () => [], pluginChanges: () => Promise.resolve() }).map(step => step.name)).toEqual(['stock-import-recovery', 'data-copy-recovery', 'data-format-record', 'profile-migrations', 'changes', 'plugin-changes', 'update-notice'])
  })

  it('run every step for the CLI profile, and all but the restore recovery for delorun headless', async () => {
    const cli: string[] = []
    await runPreStartSteps(recorded(cli, []), context('cli'))
    expect(cli).toEqual(['stock-import-recovery', 'data-copy-recovery', 'data-format-record', 'profile-migrations', 'changes', 'plugin-changes', 'update-notice'])
    const headless: string[] = []
    await runPreStartSteps(recorded(headless, []), context('headless'))
    expect(headless).toEqual(['stock-import-recovery', 'data-format-record', 'profile-migrations', 'changes', 'plugin-changes', 'update-notice'])
  })

  it('ask for the migrations of the headless profile on every delorun headless run, and none for a successor', async () => {
    const migrated: PreStartContext[] = []
    await runPreStartSteps(recorded([], migrated), context('headless'))
    await runPreStartSteps(recorded([], migrated), context('headless'))
    expect(migrated.map(start => `${start.kind}:${start.profile}`)).toEqual(['headless:headless', 'headless:headless'])
    const successors: PreStartContext[] = []
    await runPreStartSteps(recorded([], successors), context('headless', true))
    expect(successors).toEqual([])
  })

  it('make the profile\'s one-time changes on a fresh start and none for an update\'s successor', async () => {
    const migrated: PreStartContext[] = []
    await runPreStartSteps(recorded([], migrated), context('cli', true))
    expect(migrated).toEqual([])
    await runPreStartSteps(recorded([], migrated), context('cli'))
    expect(migrated.map(start => start.profile)).toEqual(['default'])
  })

  it('run the plugin change check for both starts, an update\'s successor included', async () => {
    const checked: string[] = []
    const steps = preStartSteps({ migrations: () => [], pluginChanges: (start) => { checked.push(`${start.kind}:${String(start.successor)}`); return Promise.resolve() } }).filter(step => step.name === 'plugin-changes')
    await runPreStartSteps(steps, context('cli'))
    await runPreStartSteps(steps, context('cli', true))
    await runPreStartSteps(steps, context('headless'))
    expect(checked).toEqual(['cli:false', 'cli:true', 'headless:false'])
  })

  it('stop at the first step that refuses, and run none after it', async () => {
    const ran: string[] = []
    const refusal = new Error('the import journal cannot be trusted')
    const steps: PreStartStep[] = recorded(ran, []).map(step => step.name === 'stock-import-recovery' ? { ...step, run: () => Promise.reject(refusal) } : step)
    await expect(runPreStartSteps(steps, context('cli'))).rejects.toBe(refusal)
    expect(ran).toEqual([])
  })

  it('finish no restore and withdraw no import on a home without either, and leave the notice slot doing nothing until its feature fills it', async () => {
    const real = preStartSteps({ migrations: () => [], pluginChanges: () => Promise.resolve() })
    await expect(real.find(step => step.name === 'data-copy-recovery')!.run(context('cli'))).resolves.toBeUndefined()
    await expect(real.find(step => step.name === 'data-format-record')!.run(context('cli'))).resolves.toBeUndefined()
    await expect(recoverStockImportStep(context('cli'))).resolves.toBeUndefined()
    await expect(updateNoticeStep(context('headless'))).resolves.toBeUndefined()
  })
})
