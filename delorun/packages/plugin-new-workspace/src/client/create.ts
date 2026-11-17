/**
 * Finishing the flow: add the chosen folder, make the new one, or follow the clone started on the clone screen until the
 * Host has added it. A failure carries the wire's own reason so the dialog shows it in place on the right screen.
 * @module @delorun/plugin-new-workspace/client/create
 */
import type { ApiFailure, NewWorkspaceApi } from './api.ts'
import { assertNever, type Choice, type Problem } from './flow.ts'

/** How often a running clone is asked how far it is, in milliseconds. */
export const CLONE_POLL_MS = 1000

/** How many reads of a running clone may fail in a row before the clone is given up on. */
const POLL_FAILURES_ALLOWED = 3

/** What finishing the flow came to. */
export type CreateResult =
  | { readonly ok: true, readonly workspaceId: string, readonly path: string }
  | { readonly ok: false, readonly problem: Problem }
  | { readonly ok: false, readonly cancelled: true }

/** What {@link createChosen} may be given besides the choice. */
export interface CreateOptions {
  /** Stops following a clone and resolves the result as cancelled; the clone itself keeps running on the Host. */
  readonly signal?: AbortSignal
  /**
   * Wait between two reads of a clone.
   * @param ms - how long.
   * @returns a promise that resolves after `ms`.
   */
  readonly wait?: (ms: number) => Promise<void>
}

/**
 * The problem a request that got no answer stands for.
 * @param reason - why there was no answer.
 * @returns the problem to show.
 */
export function problemOfFailure(reason: ApiFailure): Problem {
  switch (reason) {
    case 'locked': return { kind: 'locked' }
    case 'refused-arrival': return { kind: 'refused-arrival' }
    case 'failed': return { kind: 'failed' }
    default: return assertNever(reason)
  }
}

/**
 * Finish the flow for what was chosen.
 * @param api - the Host client.
 * @param choice - what the person chose; a clone must already have a `job`.
 * @param onProgress - called with the percent a running clone reports, or undefined when Git has not reported one.
 * @param options - cancellation and, for a test, the wait.
 * @returns the new workspace, or the reason it was not made.
 */
export async function createChosen(
  api: NewWorkspaceApi,
  choice: Choice,
  onProgress: (percent: number | undefined) => void,
  options: CreateOptions = {},
): Promise<CreateResult> {
  switch (choice.kind) {
    case 'existing': {
      const added = await api.add(choice.path)
      if (!added.ok) return { ok: false, problem: problemOfFailure(added.reason) }
      if (added.value.result === 'added') return { ok: true, workspaceId: added.value.workspaceId, path: added.value.path }
      return { ok: false, problem: added.value.result === 'refused' ? { kind: 'place', problem: added.value.problem } : { kind: 'failed' } }
    }
    case 'new': {
      const made = await api.create({ parent: choice.parent, name: choice.name, git: choice.git })
      if (!made.ok) return { ok: false, problem: problemOfFailure(made.reason) }
      if (made.value.result === 'added') return { ok: true, workspaceId: made.value.workspaceId, path: made.value.path }
      return { ok: false, problem: made.value.result === 'refused' ? { kind: 'create', problem: made.value.problem } : { kind: 'failed' } }
    }
    case 'clone':
      return followClone(api, choice.job, onProgress, options)
    default:
      return assertNever(choice)
  }
}

/**
 * Ask a started clone how far it is until the Host has added it, failed it or lost it.
 * @param api - the Host client.
 * @param job - the clone's job.
 * @param onProgress - called with each reported percent.
 * @param options - cancellation and the wait.
 * @returns the new workspace, or why the clone did not become one.
 */
async function followClone(api: NewWorkspaceApi, job: string | undefined, onProgress: (percent: number | undefined) => void, options: CreateOptions): Promise<CreateResult> {
  if (job === undefined) return { ok: false, problem: { kind: 'failed' } }
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  let failures = 0
  const cancelled = (): boolean => options.signal?.aborted === true
  for (;;) {
    if (cancelled()) return { ok: false, cancelled: true }
    const status = await api.cloneStatus(job)
    if (cancelled()) return { ok: false, cancelled: true }
    if (!status.ok) {
      if (status.reason !== 'failed') return { ok: false, problem: problemOfFailure(status.reason) }
      failures += 1
      if (failures >= POLL_FAILURES_ALLOWED) return { ok: false, problem: { kind: 'failed' } }
    } else {
      failures = 0
      switch (status.value.state) {
        case 'done': return { ok: true, workspaceId: status.value.workspaceId, path: status.value.path }
        case 'failed': return { ok: false, problem: { kind: 'clone-failed', failure: status.value.failure } }
        case 'unknown': return { ok: false, problem: { kind: 'clone-lost' } }
        case 'running': onProgress(status.value.percent); break
        default: assertNever(status.value)
      }
    }
    await wait(CLONE_POLL_MS)
  }
}
