/**
 * The restart of contract C19 as the home process gives it to the Host it boots (the `changesRestart` service, which the
 * studio's Restart route uses), and the leave-out a failed restart runs ([`@delorun/changes`](../../../../packages/changes/src/harness-live.ts)).
 * A Host outside the runtime store gets no service, and the studio says a restart is not available there.
 *
 * @module @delorun/cli/changes/restart-service
 */
import type { Context } from '@deepseek-ai/cordis'
import { leaveOutNewestHarnessChange, newestAppliedHarnessChange, type ChangesRestartHost, type RunningComposition } from '@delorun/changes'
import type { RestartControl, RestartSupport } from '@delorun/home-process'

/** The composition the latest Host of this process booted with; each boot sets it. */
export interface RunningHolder {
  current: RunningComposition
}

/**
 * Provide `changesRestart` on the Host's root context for as long as it runs.
 * @param root - the Host's root context, before the Loader mounts its first row.
 * @param control - the home process's restart, or undefined outside the runtime store.
 * @param running - what this Host booted with.
 */
export function provideChangesRestart(root: Context, control: RestartControl | undefined, running: RunningComposition): void {
  if (control === undefined) return
  const host: ChangesRestartHost = {
    running,
    view: () => control.view(),
    runningChats: () => control.runningChats(),
    begin: async (request) => {
      const { runningChats } = await control.begin(request)
      return { runningChats }
    },
    cancel: () => control.cancel(),
    clearFailure: () => { control.clearFailure() },
  }
  root.effect(() => root.provide('changesRestart', host), 'delorun changes restart')
}

/**
 * The leave-out after a failed restart: the runtime's newest harness change, when it is an applied one the running Host
 * does not run. A Host whose composition is unknown counts every change as not run.
 * @param home - the Delorun home.
 * @param runtime - the runtime version.
 * @param running - what the latest Host booted with.
 * @returns the support.
 */
export function restartSupport(home: string, runtime: string, running: RunningHolder): RestartSupport {
  return {
    async leaveOut(failure) {
      const newest = await newestAppliedHarnessChange(home, runtime)
      const file = newest?.subject.file
      if (newest === undefined || file === undefined) return undefined
      const booted = running.current
      if (booted.kind === 'known' && booted.files[file] === newest.to) return undefined
      const left = await leaveOutNewestHarnessChange(home, runtime, failure)
      return left?.subject.file === undefined ? undefined : { id: left.id, file: left.subject.file }
    },
  }
}
