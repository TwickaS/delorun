/**
 * The deployment of the release channel: an R2 bucket per stage, the public read-only Worker that serves it, and the
 * cron Worker that re-signs `timestamp.json` daily. The `prod` stage serves `releases.delorun.com` (main) and
 * `releases.delo.run` (spare); every other stage has only its workers.dev address. Stages never share a bucket.
 *
 * The timestamp key is the Worker secret `DELO_TIMESTAMP_KEY`, read from the environment of the deploying process and
 * bound as `TIMESTAMP_KEY` on the cron Worker alone. The mark secret is `DELO_MARK_SECRET`, bound as `MARK_SECRET` on
the same Worker, which answers only the publisher's HMAC-signed mark request on its workers.dev address.
 *
 * @module @delo/release-channel/alchemy.run
 */
import { fileURLToPath } from 'node:url'
import * as Cloudflare from '@alchemy.run/cloudflare'
import * as Alchemy from 'alchemy'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'

/** The seconds a non-production stage keeps `releases/` and `root/` objects locked; `prod` locks them indefinitely. */
const STAGING_LOCK_SECONDS = 7 * 86_400

/** The daily re-signing run, at 03:17 UTC. */
const RESIGN_CRON = '17 3 * * *'

const source = (name: string): string => fileURLToPath(new URL(`../src/${name}`, import.meta.url))

export default Alchemy.Stack(
  'DeloReleaseChannel',
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack
    const prod = stage === 'prod'
    const condition = prod ? { type: 'Indefinite' as const } : { type: 'Age' as const, maxAgeSeconds: STAGING_LOCK_SECONDS }
    const releases = yield* Cloudflare.R2.Bucket('Releases', {
      name: `delo-releases-${stage}`,
      locks: [
        { id: 'releases', enabled: true, prefix: 'releases/', condition },
        { id: 'root', enabled: true, prefix: 'root/', condition },
      ],
    })
    const mark = yield* Cloudflare.KV.Namespace('Mark', { title: `delo-release-mark-${stage}` })
    const channel = yield* Cloudflare.Worker('Channel', {
      main: source('worker.ts'),
      env: { RELEASES: releases },
      domain: prod ? { name: 'releases.delorun.com', aliases: ['releases.delo.run'] } : undefined,
    })
    const resign = yield* Cloudflare.Worker('Resign', {
      main: source('resign-worker.ts'),
      env: { RELEASES: releases, MARK: mark, TIMESTAMP_KEY: Config.Redacted('DELO_TIMESTAMP_KEY'), MARK_SECRET: Config.Redacted('DELO_MARK_SECRET') },
      crons: [RESIGN_CRON],
      workersDev: true,
    })
    return { url: channel.url, bucket: releases.bucketName, markUrl: resign.url }
  }),
)
