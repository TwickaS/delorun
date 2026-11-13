/**
 * The cron Worker: re-signs `timestamp.json` on each scheduled run. It holds the timestamp private key as the secret
 * `TIMESTAMP_KEY` and the bucket binding `RELEASES`, which it uses to read metadata and to replace `timestamp.json`
 * conditionally. It serves no request. A raced run ends quietly and the next run retries; any other failure throws so
 * Cloudflare records the run as failed.
 *
 * @module @delo/release-channel/resign-worker
 */
import { resignTimestamp, timestampKey } from './resign-core.ts'
import { r2Store, type WritableBucket } from './r2-store.ts'

/** The cron Worker's bindings. */
export interface ResignEnv {
  /** The release bucket. */
  readonly RELEASES: WritableBucket
  /** The timestamp private key, PKCS #8 PEM. */
  readonly TIMESTAMP_KEY: string
}

export default {
  fetch: (): Response => new Response('Not found\n', { status: 404 }),
  scheduled: async (controller: { readonly scheduledTime: number }, env: ResignEnv): Promise<void> => {
    const result = await resignTimestamp({ store: r2Store(env.RELEASES), key: timestampKey(env.TIMESTAMP_KEY), now: Math.floor(controller.scheduledTime / 1000) })
    console.log(result.outcome === 'raced' ? 'resign: a publish replaced timestamp.json first; retrying next run' : `resign: version ${String(result.version)}, expires ${result.expires}`)
  },
}
