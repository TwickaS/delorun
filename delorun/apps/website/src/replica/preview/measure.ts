/**
 * The replica's weight: builds the local preview and prints each output's gzip size and the sums the weight limits
 * name: the live replica's chunk and the drawn studio's chunk (script and styles, tokens included) with the larger
 * session, then each session. The page's start script carries only `ReplicaFrame.tsx`'s shell; the site's own
 * `scripts/check-weight.ts` measures that once the page places the replica. Run `node src/replica/preview/measure.ts`
 * in `delorun/apps/website`.
 * @module @delorun/website/replica/preview/measure
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { build } from 'vite'

// The sessions are stand-ins; this measures a review build, never one that is deployed.
process.env['SITE_ALLOW_STANDINS'] = '1'
const outDir = join(tmpdir(), 'delorun-replica-measure')
rmSync(outDir, { recursive: true, force: true })
await build({
  configFile: new URL('./vite.config.ts', import.meta.url).pathname,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
  },
})

const assets = join(outDir, 'assets')
const sizes = new Map(readdirSync(assets).filter(name => /\.(js|css)$/.test(name)).map(name => [name, gzipSync(readFileSync(join(assets, name)), { level: 9 }).length]))
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`
const sum = (pattern: RegExp): number => [...sizes].filter(([name]) => pattern.test(name)).reduce((total, [, size]) => total + size, 0)
for (const [name, size] of [...sizes].sort((a, b) => b[1] - a[1])) console.log(`${kb(size).padStart(9)}  ${name}`)
const sessions = [...sizes].filter(([name]) => /\.session-/.test(name)).map(([, size]) => size)
const core = sum(/^Replica(Live|Studio)-/) + Math.max(...sessions)
console.log(`\nreplica script, styles and tokens with one session: ${kb(core)} (limit 120 KB)`)
console.log(`each further session: ${sessions.map(kb).join(', ')} (limit 15 KB)`)
