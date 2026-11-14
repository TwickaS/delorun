/**
 * A home process started in the spec's own process with a stand-in Host, so `delorun status` and `delorun doctor`
 * ask a real update channel for the `status` answer. The Host serves no studio of its own: it reports the address the
 * spec gives it.
 *
 * @module @delorun/cli/tests/fixtures/running-home
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { ensureHomeTree, newStartId } from '@delorun/home'
import { CountingChatGate, HomeProcess, updateChannelProbe, type RunningHost } from '@delorun/home-process'
import { Redactor, type DelorunLogger } from '@delorun/logs'

/** A running fixture home process. */
export interface RunningHome {
  /**
   * Stop it and run its exit listeners, which remove the lock, the token file and the socket.
   * @returns when it has stopped.
   */
  stop(): Promise<void>
}

/** A logger that writes nowhere. */
const SILENT: DelorunLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }

/**
 * Start a home process for a profile whose Host reports a studio address.
 * @param home - the Delorun home; its tree is created.
 * @param profile - the CLI profile.
 * @param studio - the address the Host reports, or `undefined` for a Host that serves no studio.
 * @returns the running home process.
 */
export async function startRunningHome(home: string, profile: string, studio: string | undefined): Promise<RunningHome> {
  await ensureHomeTree(home, profile)
  const host: RunningHost = {
    chats: new CountingChatGate(),
    studio: () => studio,
    studioLink: () => ({ kind: 'unavailable', reason: 'the Host serves no studio' }),
    failedRows: () => [],
    rows: () => [],
    protection: () => undefined,
    check: () => Promise.resolve({ passed: true }),
    suspend: () => Promise.resolve(),
    close: () => Promise.resolve(),
    reload: () => Promise.resolve({ ok: true }),
  }
  const listeners: (() => void)[] = []
  const started = await HomeProcess.start({
    home,
    profile,
    running: brandString<RuntimeVersion>('0.0.0-fixture'),
    startId: newStartId(),
    host: { boot: () => Promise.resolve(host) },
    probe: updateChannelProbe(home, profile),
    logger: SILENT,
    redactor: new Redactor(),
    updates: undefined,
    supervisor: undefined,
    preStart: () => Promise.resolve(),
    onSignal: () => () => {},
    onExit: (listener) => { listeners.push(listener) },
    exit: () => {},
  })
  return {
    async stop() {
      await started.shutdown(0)
      for (const listener of listeners.splice(0)) listener()
    },
  }
}
