/**
 * The replica's weight: builds the local preview with the replica's code that the page loads at once (the frame, the
 * player, the still, the chapter files) in a chunk of its own, then prints each output's gzip size and the sums the
 * weight limits name. Brand pieces the frame imports count as the replica's, though the page shares them. Run
 * `node src/replica/preview/measure.ts` in `delorun/apps/website`.
 * @module @delorun/website/replica/preview/measure
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { build } from 'vite'

/** The replica's and the brand's modules; of them, the ones only the lazy studio loads stay in its chunks. */
const ENTRY = /\/(apps\/website\/src\/replica|packages\/brand\/src)\/(?!preview\/)/
const LAZY = /\/src\/replica\/(Studio\.tsx|screens\/real\.tsx|studio\/|sessions\/[^/]+\.fixture\.ts)/

const outDir = join(tmpdir(), 'delorun-replica-measure')
rmSync(outDir, { recursive: true, force: true })
await build({
  configFile: new URL('./vite.config.ts', import.meta.url).pathname,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'replica-entry', test: (id: string) => ENTRY.test(id) && !LAZY.test(id) }],
        },
      },
    },
  },
})

const assets = join(outDir, 'assets')
const sizes = new Map(readdirSync(assets).filter(name => /\.(js|css)$/.test(name)).map(name => [name, gzipSync(readFileSync(join(assets, name)), { level: 9 }).length]))
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`
const sum = (pattern: RegExp): number => [...sizes].filter(([name]) => pattern.test(name)).reduce((total, [, size]) => total + size, 0)
for (const [name, size] of [...sizes].sort((a, b) => b[1] - a[1])) console.log(`${kb(size).padStart(9)}  ${name}`)
const sessions = [...sizes].filter(([name]) => /\.fixture-/.test(name)).map(([, size]) => size)
const core = sum(/^(replica-entry|Studio)-/) + Math.max(...sessions)
console.log(`\nreplica script, styles and tokens with one session: ${kb(core)} (limit 120 KB)`)
console.log(`each further session: ${sessions.map(kb).join(', ')} (limit 15 KB)`)
