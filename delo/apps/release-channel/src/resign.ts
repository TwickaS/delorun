/**
 * Re-signs the current `timestamp.json` from a command line, so a scheduled workflow can run what the cron Worker runs
 * ({@link resignTimestamp}):
 *
 * `node delo/apps/release-channel/src/resign.ts --stage <stage> --account <Cloudflare account id>`
 *
 * `DELO_TIMESTAMP_KEY` (PKCS #8 PEM), `DELO_R2_ACCESS_KEY_ID` and `DELO_R2_SECRET_ACCESS_KEY` come from the
 * environment. The bucket is `delo-releases-<stage>`. A run that loses the conditional write to a publish exits 0 and
 * says so; the publish's file stands.
 *
 * @module @delo/release-channel/resign
 */
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { releaseBucket } from './bucket.ts'
import { resignTimestamp, timestampKey } from './resign-core.ts'
import { s3Store } from './s3-store.ts'

async function main(argv: readonly string[]): Promise<number> {
  try {
    const { values } = parseArgs({ args: [...argv], strict: true, options: { 'stage': { type: 'string' }, 'account': { type: 'string' } } })
    if (values.stage === undefined || values.account === undefined) throw new Error('pass --stage <stage> and --account <Cloudflare account id>')
    const accessKeyId = process.env.DELO_R2_ACCESS_KEY_ID
    const secretAccessKey = process.env.DELO_R2_SECRET_ACCESS_KEY
    if (accessKeyId === undefined || secretAccessKey === undefined) throw new Error('DELO_R2_ACCESS_KEY_ID and DELO_R2_SECRET_ACCESS_KEY hold no S3 token')
    const store = s3Store({ accountId: values.account, bucket: releaseBucket(values.stage), accessKeyId, secretAccessKey })
    const result = await resignTimestamp({ store, key: timestampKey(process.env.DELO_TIMESTAMP_KEY), now: Math.floor(Date.now() / 1000) })
    console.log(result.outcome === 'raced' ? 'resign: another writer replaced timestamp.json first; its file stands, run again later' : `resign: version ${String(result.version)}, expires ${result.expires}`)
    return 0
  } catch (error) {
    console.error(`resign: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
