/**
 * The `relay` surface's driver for C20's cross-surface denial suite
 * (`delo/packages/logs/tests/denial/`): it opens the relay's log through `openRelayLog`, the same
 * writer the container runs, and captures a child process's output into it. The relay keeps its
 * file at `/var/log/delo-relay/relay.log` inside its own container, so the driver writes to a
 * directory of its own and clears that directory itself.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { captureStream, clearSurface, LineCapture, type CapturedStream, type LogsFailure, type RetentionReport } from '@delo/logs'
import { openRelayLog } from '../src/log.ts'
import type { SurfaceDriver } from '../../../packages/logs/tests/denial/surfaces.ts'

/** A child process that prints its standard input's writes, each in its own write call, to one stream. */
const PRINTER = `
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', async () => {
  const { stream, writes } = JSON.parse(input)
  for (const text of writes) {
    await new Promise(resolve => process[stream].write(text, resolve))
    await new Promise(resolve => setTimeout(resolve, 5))
  }
})
`

/** Writes the surface's records from its own directory, under the suite's home. */
export const RELAY_DIRECTORY = 'logs/relay'

/** Starts the relay surface in a Delo home. */
export const RELAY_DRIVER: SurfaceDriver = {
  start: (home) => {
    const failures: LogsFailure[] = []
    const opened = openRelayLog({ dir: join(home, RELAY_DIRECTORY), level: 'debug', onFailure: error => failures.push(error) })
    return Promise.resolve({
      location: opened.location,
      failures,
      register: (value, kind) => {
        opened.redactor.register(value, kind)
      },
      log: (message, details) => {
        opened.logger.info(message, details)
        return Promise.resolve()
      },
      print: async (stream: CapturedStream, writes: readonly string[]) => {
        const child = spawn(process.execPath, ['-e', PRINTER], { stdio: ['pipe', 'pipe', 'pipe'] })
        const stops = [captureStream(child.stdout, new LineCapture(opened.writer, 'stdout', 'info')), captureStream(child.stderr, new LineCapture(opened.writer, 'stderr', 'warn'))]
        const closed = new Promise(resolve => child.on('close', resolve))
        child.stdin.end(JSON.stringify({ stream, writes }))
        await closed
        for (const stop of stops) stop()
      },
      clear: (): RetentionReport => clearSurface(opened.location),
      stop: () => {
        opened.close()
        return Promise.resolve()
      },
    })
  },
}
