/**
 * The self-hosted relay's entry point, as its container runs it: read the configuration file
 * named by `DELORUN_RELAY_CONFIG` (C6's `/etc/delorun-relay/relay.yaml` by default), open C20's `relay`
 * surface at `/var/log/delorun-relay/relay.log`, listen on `DELORUN_RELAY_PORT` (C6's 443 by default)
 * and stop on `SIGTERM` or `SIGINT`.
 *
 * @module @delorun/relay/node/main
 */
import { pathToFileURL } from 'node:url'
import { loadRelayConfig, RELAY_CONFIG_PATH } from '../config.ts'
import { isRelayError } from '../errors.ts'
import { openRelayLog } from '../log.ts'
import { RELAY_PORT, startRelayServer } from './server.ts'

/** Run the relay until the process is stopped. */
export async function run(): Promise<void> {
  const settings = loadRelayConfig({ path: process.env.DELORUN_RELAY_CONFIG ?? RELAY_CONFIG_PATH, now: Date.now })
  const log = openRelayLog()
  const port = Number(process.env.DELORUN_RELAY_PORT ?? String(RELAY_PORT))
  const server = await startRelayServer({ settings, log: log.log, port })
  const stop = (signal: string): void => {
    log.log.info('relay stopping', { signal })
    void server.close().then(() => {
      log.close()
      process.exit(0)
    })
  }
  process.on('SIGTERM', () => {
    stop('SIGTERM')
  })
  process.on('SIGINT', () => {
    stop('SIGINT')
  })
}

/**
 * The code a start failure reports: the relay's own, the log's and the home layout's, or `ERROR`.
 * @param error - the thrown value.
 * @returns the code.
 */
export function failureCode(error: unknown): string {
  if (isRelayError(error)) return error.code
  const code = (error as { readonly code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'ERROR'
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void run().catch((error: unknown) => {
    process.stderr.write(`delorun-relay: ${failureCode(error)}: ${error instanceof Error ? error.message : 'unknown error'}\n`)
    process.exit(1)
  })
}
