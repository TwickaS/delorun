/**
 * The public Worker: serves the channel's files from the R2 bucket bound as `RELEASES`. It reads through `head` and
 * `get` only ({@link ReadOnlyBucket}); the credentials that write to the bucket are never on this Worker.
 *
 * @module @delorun/release-channel/worker
 */
import { handleChannelRequest, type ReadOnlyBucket } from './routes.ts'

/** The Worker's bindings. */
export interface PublicEnv {
  /** The release bucket. */
  readonly RELEASES: ReadOnlyBucket
}

/** The public Worker: `fetch` answers the channel's read-only requests from the release bucket. */
export default {
  fetch: async (request: Request, env: PublicEnv): Promise<Response> => await handleChannelRequest(request, env.RELEASES),
}
