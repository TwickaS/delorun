/**
 * One command for a whole review pass: serves the production build, takes every picture, runs the audit and the worst
 * cases, and writes `index.md`, `audit.md` and `report.json` into `site-pass-<n>/`. Prints the audit's summary.
 *
 * Usage: `node review/run-pass.ts --pass <n> [--build] [--release-dir <dir>] [--port 18680]`
 *
 * `--build` runs `vite build` first under `nice -n 19`. Without it the existing `out/` is served. The folder is emptied of
 * its earlier pictures and reports first, so a second run of the same build writes the same file names.
 *
 * @module @delorun/website/review/run-pass
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { audit } from './audit.ts'
import { launch } from './browser.ts'
import { capture, Shooter } from './capture.ts'
import { passFolder } from './naming.ts'
import { auditMarkdown, indexMarkdown, reportJson, summarise, summaryLines, type Report } from './report.ts'
import { waitForResources } from './resources.ts'
import { serve } from './serve.ts'
import { worstCases } from './worst.ts'

const site = fileURLToPath(new URL('..', import.meta.url))
const { values } = parseArgs({ options: { pass: { type: 'string' }, build: { type: 'boolean' }, 'release-dir': { type: 'string' }, port: { type: 'string', default: '18680' } } })
const pass = Number(values.pass)
const folder = passFolder(values['release-dir'] ?? join(homedir(), 'delorun-rc-release'), pass)
const out = resolve(site, 'out')

await waitForResources()
if (values.build === true) {
  const built = spawnSync('nice', ['-n', '19', join(site, 'node_modules/.bin/vite'), 'build'], { cwd: site, stdio: 'inherit', timeout: 900000 })
  if (built.status !== 0) throw new Error('the website build failed')
}

mkdirSync(folder, { recursive: true })
for (const file of readdirSync(folder)) if (/\.(png|md|json)$/.test(file)) rmSync(join(folder, file))

const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: site, encoding: 'utf8', timeout: 10000 }).stdout.trim()
const server = await serve(out, Number(values.port))
const base = `http://127.0.0.1:${String(values.port)}`
const browser = await launch()
try {
  const taken = await capture(browser, base, folder)
  const worst = new Shooter(folder)
  const worstFindings = await worstCases(browser, base, worst)
  const result = await audit(browser, base, out)
  const pictures = [...taken.pictures, ...worst.pictures].sort()
  const report: Report = {
    pass,
    commit,
    missingSections: [...taken.missingSections].sort(),
    findings: dedupe([...taken.findings, ...worstFindings, ...result.findings]),
    measurements: result.measurements,
    pictures,
  }
  writeFileSync(join(folder, 'index.md'), indexMarkdown(pictures))
  writeFileSync(join(folder, 'audit.md'), auditMarkdown(report))
  writeFileSync(join(folder, 'report.json'), reportJson(report))
  console.log(`pass ${String(pass)} written to ${folder}`)
  for (const line of summaryLines(summarise(report))) console.log(line)
} finally {
  await browser.close()
  server.close()
}

function dedupe<T extends { check: string; where: string; message: string; severity: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>()
  return items.filter(item => {
    const key = `${item.severity}|${item.check}|${item.where}|${item.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
