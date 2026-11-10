/**
 * What the CLI's Host reports to the home process (contracts C19 and C3): its running chats, counted from upstream's
 * `agent/status` event with each agent's own cancellation and from the job registry's events with each job's kill, the
 * held state of the gate, which `@delo/bundle-local`'s `deloTurnGate` service reads to refuse new turns, and C3's
 * health check H1 to H5 over the booted rows, the studio's listener, the runtime's files and the profile's bundle list.
 *
 * @module @delo/cli/update/host
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type {} from '@delo/bundle-local/update-gate'
import type { CountingChatGate, HealthExpectations, HealthVerdict } from '@delo/home-process'
import { bundleListOf } from '@delo/profile-safety'
import type { BootedRow } from '../delo-bundles.ts'

/** How long the studio's index has to answer H2's request. */
export const STUDIO_HEALTH_TIMEOUT_MS = 10_000

/** The reason a turn or a job cancelled by the gate carries. */
export const STOP_REASON = 'Delo is stopping or updating'

/**
 * Count the Host's running chats into the gate, and refuse new turns while it is held. A running chat is an agent
 * between its `running` and `idle` statuses, or a job of the job registry between its `registered` and `settled`
 * events; either is counted from the event that reports it, so work that began before this call is not. While the
 * `deloTurnGate` service is present, its held state is the gate's, so the first step of a new turn is refused with
 * `UPDATE_PENDING`; without the service a turn that starts while the gate is held is counted and the wait lasts until
 * it ends.
 * @param ctx - the booted profile's root context.
 * @param gate - the home process's gate.
 * @returns nothing; the listeners and the attachment are effects of `ctx` and go with it.
 */
export function watchChats(ctx: Context, gate: CountingChatGate): void {
  const ends = new Map<Agent, () => void>()
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') {
      if (!ends.has(agent)) ends.set(agent, gate.track(() => { agent.cancel({ kind: 'hook', reason: STOP_REASON }) }))
      return
    }
    ends.get(agent)?.()
    ends.delete(agent)
  })
  ctx.inject(['jobs'], (scope) => {
    const jobs = new Map<JobId, () => void>()
    scope.effect(() => scope.jobs.events.subscribe({ owners: 'all' }, (event) => {
      if (event.type === 'registered') {
        const { id, owner } = event.job
        jobs.set(id, gate.track(() => {
          try {
            scope.jobs.kill(id, owner, STOP_REASON)
          } catch (error) {
            scope.logger.warn(`the job ${id} could not be cancelled for the update or stop: ${String(error)}`)
          }
        }))
        return
      }
      if (event.type !== 'settled' && event.type !== 'removed') return
      jobs.get(event.job.id)?.()
      jobs.delete(event.job.id)
    }))
    // The registry settles its jobs when it goes; a job it never reported settled is not running either.
    scope.effect(() => () => {
      for (const end of jobs.values()) end()
      jobs.clear()
    })
  })
  ctx.inject(['deloTurnGate'], (scope) => {
    scope.effect(() => scope.deloTurnGate.attach(() => gate.held))
  })
}

/** What the health check reads from the booted Host. */
export interface HostHealthFacts {
  /** The Loader's rows after startup settled. */
  readonly rows: () => readonly BootedRow[]
  /** The studio's loopback listener, or `undefined` when it has none. */
  readonly studio: () => { readonly host: string, readonly port: number } | undefined
  /** The profile directory, whose `package.json` holds the bundle list. */
  readonly profileDir: string
  /**
   * H1: check the running runtime's files against its signed file list, or nothing when it does not run from the store.
   * @throws when a file differs.
   */
  readonly verifyRuntime: () => Promise<void>
}

/**
 * The rows that did not load at boot: disabled, failed, pending or not imported.
 * @param rows - the Loader's rows.
 * @returns their ids.
 */
export function inactiveRows(rows: readonly BootedRow[]): readonly string[] {
  return rows.filter(row => row.disabled || row.state !== 'active').map(row => row.id)
}

/**
 * Contract C3's health check over a booted Host.
 * @param facts - the rows, the studio's listener, the profile and the runtime check.
 * @param expect - what the report predicted, or `undefined` for H1 and H2 alone.
 * @returns the verdict, naming the first criterion that failed.
 */
export async function checkHealth(facts: HostHealthFacts, expect: HealthExpectations | undefined): Promise<HealthVerdict> {
  try {
    await facts.verifyRuntime()
  } catch (error) {
    return { passed: false, criterion: 'H1-release-verified', detail: error instanceof Error ? error.message : String(error) }
  }
  const studio = facts.studio()
  if (studio === undefined) return { passed: false, criterion: 'H2-host-ready', detail: 'the Host has no studio listener' }
  const host = studio.host.includes(':') ? `[${studio.host}]` : studio.host
  try {
    const answer = await fetch(`http://${host}:${String(studio.port)}/`, { signal: AbortSignal.timeout(STUDIO_HEALTH_TIMEOUT_MS) })
    await answer.body?.cancel()
    if (answer.status !== 200) return { passed: false, criterion: 'H2-host-ready', detail: `the studio's index answered ${String(answer.status)}` }
  } catch (error) {
    return { passed: false, criterion: 'H2-host-ready', detail: `the studio's index did not answer: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (expect === undefined) return { passed: true }
  const named = new Set([...expect.namedRows, ...expect.previousFailures])
  const disabledPlugins = new Set(expect.disabledPlugins)
  for (const row of facts.rows()) {
    if (!row.disabled && row.state === 'active') continue
    // A report names a row by its patch id, or by its plugin when the patch gives it none.
    if (named.has(row.id) || named.has(row.name) || disabledPlugins.has(row.name)) continue
    return row.disabled
      ? { passed: false, criterion: 'H3-only-named-disabled', detail: `row ${row.id} is disabled and the report did not name it` }
      : { passed: false, criterion: 'H4-unnamed-rows-load', detail: `row ${row.id} did not load (${row.state}) and the report did not name it` }
  }
  const present = new Set(facts.rows().map(row => row.id))
  for (const id of expect.previousRows) {
    if (present.has(id) || named.has(id)) continue
    return { passed: false, criterion: 'H3-only-named-disabled', detail: `row ${id} was in the profile before the update, is gone, and the report did not name it` }
  }
  if (expect.bundles !== undefined) {
    const path = join(facts.profileDir, 'package.json')
    const manifest: unknown = JSON.parse(await readFile(path, 'utf8'))
    const bundles = bundleListOf(manifest, path)
    if (bundles.length !== expect.bundles.length || bundles.some((bundle, at) => expect.bundles?.[at] !== bundle)) {
      return { passed: false, criterion: 'H5-bundle-list-predicted', detail: `the bundle list is ${bundles.join(', ')}; the report predicted ${expect.bundles.join(', ')}` }
    }
  }
  return { passed: true }
}
