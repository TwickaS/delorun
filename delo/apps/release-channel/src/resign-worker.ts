/**
 * The cron Worker: re-signs `timestamp.json` on each scheduled run. It holds the timestamp private key as the secret
 * `TIMESTAMP_KEY` and the bucket binding `RELEASES`, which it uses to read metadata and to replace `timestamp.json`
 * conditionally, and the Workers KV namespace `MARK` that holds the high-water mark no publish token can write. It serves only the publisher's HMAC-signed mark request. A raced run ends quietly and the next run retries; any other failure throws so
 * Cloudflare records the run as failed.
 *
 * @module @delo/release-channel/resign-worker
 */
import { resignTimestamp, timestampKey } from './resign-core.ts'
import { handleMarkRequest } from './mark-endpoint.ts'
import { kvMark, type MarkNamespace } from './mark.ts'
import { r2Store, type WritableBucket } from './r2-store.ts'

/** The cron Worker's bindings. */
export interface ResignEnv {
  /** The release bucket. */
  readonly RELEASES: WritableBucket
  /** The high-water mark's namespace, bound to this Worker alone. */
  readonly MARK: MarkNamespace
  /** The timestamp private key, PKCS #8 PEM. */
  readonly TIMESTAMP_KEY: string
  /** The secret the publisher signs its mark requests with. */
  readonly MARK_SECRET: string
}

/** The re-signing Worker: `fetch` answers the publisher's mark request ({@link handleMarkRequest}) and 404 otherwise; `scheduled` re-signs the timestamp and logs the outcome. */
export default {
  fetch: async (request: Request, env: ResignEnv): Promise<Response> => await handleMarkRequest(request, { secret: env.MARK_SECRET, bucket: r2Store(env.RELEASES), mark: kvMark(env.MARK) }),
  scheduled: async (controller: { readonly scheduledTime: number }, env: ResignEnv): Promise<void> => {
    const result = await resignTimestamp({ store: r2Store(env.RELEASES), mark: kvMark(env.MARK), key: timestampKey(env.TIMESTAMP_KEY), now: Math.floor(controller.scheduledTime / 1000) })
    console.log(result.outcome === 'raced' ? 'resign: a publish replaced timestamp.json first; retrying next run' : `resign: version ${String(result.version)}, expires ${result.expires}`)
  },
}
