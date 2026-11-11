/**
 * The `home-<profile>` surface's driver for C20's cross-surface denial suite (`delo/packages/logs/tests/denial/`): it
 * starts a real home process in the suite's home, writing through the same log, redactor and output capture the
 * home process uses, with a fixture Host and runtime store, so the suite's records and the home process's own records
 * share one surface.
 */
import { ensureHomeTree, newStartId } from '@delo/home'
import type { LogsFailure } from '@delo/logs'
import type { SurfaceDriver } from '../../logs/tests/denial/surfaces.ts'
import { captureHomeOutput, HomeProcess, openHomeLog, updateChannelProbe } from '../src/index.ts'
import { behaviourOf, FixtureHostRunner, FixtureCopies, FixtureHarness, FixtureSnapshots, FixtureStore, installFixture, PROFILE, V1 } from './support.ts'

/** Starts the home surface in a Delo home. */
export const HOME_DRIVER: SurfaceDriver = {
  start: async (home) => {
    await ensureHomeTree(home, PROFILE)
    installFixture(home, V1)
    await FixtureStore.seed(home, V1)
    const failures: LogsFailure[] = []
    const startId = newStartId()
    const opened = openHomeLog({ home, profile: PROFILE, startId, level: 'debug', onFailure: (error) => { failures.push(error) } })
    const exits: (() => void)[] = []
    const snapshots = new FixtureSnapshots()
    const running = await HomeProcess.start({
      home, profile: PROFILE, running: V1, startId, host: new FixtureHostRunner(() => behaviourOf(home, V1)), preStart: () => Promise.resolve(), probe: updateChannelProbe(home, PROFILE), logger: opened.logger, redactor: opened.redactor,
      updates: { store: new FixtureStore(home, PROFILE), snapshots, copies: new FixtureCopies(snapshots), harness: new FixtureHarness() }, supervisor: undefined,
      onExit: (listener) => { exits.push(listener) },
      onSignal: () => () => {},
      exit: () => {},
    })
    return {
      location: opened.log.location,
      failures,
      register: (value, kind) => { opened.redactor.register(value, kind) },
      log: (message, details) => {
        opened.logger.info(message, details)
        return Promise.resolve()
      },
      print: async (stream, writes) => {
        const restore = captureHomeOutput(opened.log, false)
        try {
          for (const text of writes) await new Promise(resolve => process[stream].write(text, resolve))
        } finally {
          restore()
        }
      },
      stop: async () => {
        await running.shutdown(0)
        for (const listener of exits.splice(0)) listener()
        opened.log.close()
      },
    }
  },
}
