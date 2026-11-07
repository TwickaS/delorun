/**
 * The `supervisor-<profile>` surface's driver for C20's cross-surface denial suite
 * (`delo/packages/logs/tests/denial/`): it starts a real supervisor in the suite's home, writing through the same
 * log, redactor and output capture the supervisor process uses, with no Docker engine, so the suite's records and
 * the supervisor's own records share one surface.
 */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { StartToken } from '@delo/contract-home-layout'
import { ensureHomeTree, writeProtectedFile } from '@delo/home'
import type { LogsFailure } from '@delo/logs'
import type { SurfaceDriver } from '../../logs/tests/denial/surfaces.ts'
import { captureSupervisorOutput, openSupervisorLog, startTokenFile, Supervisor } from '../src/index.ts'
import { fixtureManifest } from './support.ts'

const PROFILE = 'default'

/** Starts the supervisor surface in a Delo home. */
export const SUPERVISOR_DRIVER: SurfaceDriver = {
  start: async (home) => {
    await ensureHomeTree(home, PROFILE)
    const token = randomBytes(32).toString('base64url') as StartToken
    await writeProtectedFile(startTokenFile(home, PROFILE), `${token}\n`)
    const failures: LogsFailure[] = []
    const opened = openSupervisorLog({ home, profile: PROFILE, startId: randomBytes(16).toString('hex'), level: 'debug', onFailure: (error) => { failures.push(error) } })
    opened.redactor.register(token, 'start-token')
    const supervisor = await Supervisor.start({
      home, profile: PROFILE, token, manifest: fixtureManifest(), pull: 'none', logger: opened.logger,
      env: { DOCKER_HOST: `unix://${join(home, 'no-docker.sock')}`, DOCKER_CONFIG: join(home, 'no-docker-config') }, osHome: homedir(), seccompDirectory: join(home, 'no-seccomp'),
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
        const restore = captureSupervisorOutput(opened.log)
        try {
          for (const text of writes) await new Promise(resolve => process[stream].write(text, resolve))
        } finally {
          restore()
        }
      },
      stop: async () => {
        await supervisor.close()
        opened.log.close()
      },
    }
  },
}
