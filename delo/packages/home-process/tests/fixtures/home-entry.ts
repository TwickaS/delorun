/**
 * Test-only home-process entry, which the fixture runtime store names as each version's command: `successor` reads
 * the handover from file descriptor 3 and takes over; `start` runs a fresh start. Its Host behaves as the version's
 * `fixture.json` says, its chats are a counting gate nobody feeds, and it logs to the profile's `home-<profile>`
 * surface. Arguments: `<mode> <home> <profile> <version>`; nothing secret is among them.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { newStartId } from '@delo/home'
import { HomeProcess, openHandoverPipe, openHomeLog, updateChannelProbe, type HomeProcessOptions } from '../../src/index.ts'
import { behaviourOf, FixtureCopies, FixtureHostRunner, FixtureSnapshots, FixtureStore } from '../support.ts'

const [mode, home = '', profile = '', versionText = ''] = process.argv.slice(2)
const version = brandString<RuntimeVersion>(versionText)

/**
 * The options of this process, with the start id it logs and locks under.
 * @param startId - the start id.
 * @param running - the version it runs.
 * @returns the options.
 */
function optionsOf(startId: HomeProcessOptions['startId'], running: RuntimeVersion): HomeProcessOptions {
  const { log, redactor, logger } = openHomeLog({ home, profile, startId, level: 'debug', onFailure: () => {} })
  const snapshots = new FixtureSnapshots()
  process.on('exit', () => { log.close() })
  return {
    home, profile, running, startId, host: new FixtureHostRunner(() => behaviourOf(home, running)), probe: updateChannelProbe(home, profile), logger, redactor,
    updates: { store: new FixtureStore(home, profile), snapshots, copies: new FixtureCopies(snapshots) }, supervisor: undefined,
    onExit: (listener) => { process.on('exit', listener) },
    exit: (code) => { process.exit(code) },
  }
}

let running: HomeProcess | undefined
process.on('SIGTERM', () => { void (running?.shutdown(0) ?? Promise.resolve(process.exit(0))) })
try {
  if (mode === 'successor') {
    const pipe = await openHandoverPipe()
    running = await HomeProcess.takeOver(optionsOf(pipe.handover.startId, pipe.handover.to), pipe)
  } else {
    running = await HomeProcess.start(optionsOf(newStartId(), version))
  }
} catch (_failed) {
  // The home process logged the failure to its own log.
  process.exit(1)
}
