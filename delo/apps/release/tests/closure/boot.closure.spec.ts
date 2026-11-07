/**
 * A built runtime closure boots: extracted to an empty directory, its own Node runs `delorun setup --yes` against an
 * empty home with no pnpm on `PATH`, so setup must find Delo's bundle through the install anchor rather than link
 * it, and then `delorun start --foreground`'s own code starts the CLI profile with the CLI's own profile runner, and
 * every row whose module is a `@delo/` package is active. The client artifacts carry the title `closure.json` names. It runs only when
 * `DELO_CLOSURE_ARCHIVE` names a `linux-x64` closure archive that `build-closure.ts` built.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRecipe } from '../../src/closure/config.ts'
import { scratch } from '../support.ts'

const ARCHIVE = process.env.DELO_CLOSURE_ARCHIVE

/**
 * The start driver, written into the extracted `app/` so its imports resolve through the closure's `node_modules`.
 * It points the Web application at an OS-assigned port through a `webserver` row in the profile's own
 * `cordis.patch.yml`, which upstream's profile loading applies. A patch row replaces the row's whole config, so the
 * driver copies the config of the `webserver` row that the installed `@deepseek-ai/dsh-web-app` bundle declares and
 * changes only its `port`. It then runs `delorun start --foreground`'s own function with the CLI's own dependencies,
 * keeping the booted profile's handle to read its rows, prints the outcome and each row's id, module and state as one
 * JSON line, shuts the profile down and exits.
 */
const START_DRIVER = `
import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { prepareHome } from '@delo/cli/src/command.js'
import { CliError } from '@delo/cli/src/exit.js'
import { profileDirectory } from '@delo/cli/src/profile.js'
import { startForeground, upstreamDependencies } from '@delo/cli/src/start.js'
const context = { env: { ...process.env }, stdout: text => void process.stderr.write(text), stderr: text => void process.stderr.write(text) }
const { home, profile } = await prepareHome(context, undefined)
const bundle = readFileSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml')), 'utf8').split('\\n')
const indent = line => line.length - line.trimStart().length
const row = bundle.findIndex(line => line.trim() === '- id: webserver')
const config = bundle.findIndex((line, index) => index > row && line.trim() === 'config:')
const block = []
for (const line of bundle.slice(config + 1)) {
  if (line.trim() === '' || indent(line) <= indent(bundle[config])) break
  block.push(line.slice(indent(bundle[config]) + 2))
}
const ports = block.filter(line => line.startsWith('port:'))
if (row < 0 || config < 0 || ports.length !== 1) throw new Error('the web app bundle has no webserver row with one port setting')
const patched = block.map(line => (line.startsWith('port:') ? 'port: 0' : line))
appendFileSync(join(profileDirectory(home.path, profile), 'cordis.patch.yml'), ['- id: webserver', '  config:', ...patched.map(line => '    ' + line), ''].join('\\n'))
const cli = upstreamDependencies()
let booted
let rows = []
try {
  await startForeground({ home: home.path, profile, open: false, output: context }, {
    ...cli,
    async runProfile(options) {
      booted = await cli.runProfile(options)
      return booted
    },
  })
  rows = booted.rows()
  process.stdout.write(JSON.stringify({ outcome: 'started', rows }) + '\\n')
  await booted.shutdown(0)
  process.exit(0)
} catch (error) {
  rows = booted?.rows() ?? []
  process.stdout.write(JSON.stringify({ outcome: 'refused', rows, message: error instanceof CliError ? error.message : String(error) }) + '\\n')
  process.exit(1)
}
`

function packageJsonFiles(directory: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) found.push(...packageJsonFiles(path))
    else if (name === 'package.json') found.push(path)
  }
  return found
}

describe.runIf(ARCHIVE !== undefined)('an extracted runtime closure', { timeout: 600_000 }, () => {
  it('sets up a new home without linking, starts the CLI profile with every Delo row active, and presents the closure\'s title', (test) => {
    const root = scratch(test, 'delo-closure-boot-')
    const extracted = join(root, 'closure')
    mkdirSync(extracted)
    const unpack = spawnSync('tar', ['-x', '-z', '-f', ARCHIVE!, '-C', extracted], { encoding: 'utf8' })
    expect(unpack.stderr).toBe('')
    const node = join(extracted, 'node/bin/node')
    const home = join(root, 'home')
    mkdirSync(home)
    const env = { HOME: home, PATH: `${join(extracted, 'node/bin')}:/usr/bin:/bin`, LANG: 'C.UTF-8', DEEPSEEK_API_KEY: 'sk-closure-boot-spec' }
    expect(spawnSync('sh', ['-c', 'command -v pnpm'], { env, encoding: 'utf8' }).status).not.toBe(0)

    const setup = spawnSync(node, [join(extracted, 'app/node_modules/@delo/cli/src/bin.js'), 'setup', '--yes'], { cwd: root, env, encoding: 'utf8' })
    expect(setup.stderr).not.toContain('Error')
    expect(setup.status).toBe(0)
    const links = packageJsonFiles(join(home, '.delo')).filter(path => readFileSync(path, 'utf8').includes('"link:'))
    expect(links).toEqual([])

    const driver = join(extracted, 'app/delo-boot-driver.mjs')
    writeFileSync(driver, START_DRIVER)
    const start = spawnSync(node, [driver], { cwd: root, env, encoding: 'utf8' })
    const report = JSON.parse(start.stdout.trim().split('\n').at(-1) ?? '{}') as { outcome?: string, message?: string, rows?: Array<{ id: string, name: string, state: string }> }
    expect(report.message).toBeUndefined()
    expect(report.outcome).toBe('started')
    expect(start.status).toBe(0)
    const delo = (report.rows ?? []).filter(row => row.name.startsWith('@delo/'))
    expect(delo.map(row => row.id)).toContain('delo-privacy')
    expect(delo.filter(row => row.state !== 'active')).toEqual([])

    const title = readRecipe().closure.clientTitle
    const dist = join(extracted, 'app/node_modules/@deepseek-ai/dsh-web-frontend/dist')
    const html = readFileSync(join(dist, 'index.html'), 'utf8')
    expect(html).toContain(`<title>${title}</title>`)
    expect(html).toContain(`<meta name="apple-mobile-web-app-title" content="${title}" />`)
    if (existsSync(join(dist, 'manifest.webmanifest'))) expect(JSON.parse(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8')).name).toBe(title)
  })

  it('needs the install anchor\'s declaration: without it, setup cannot make Delo\'s bundle importable', (test) => {
    const root = scratch(test, 'delo-closure-anchor-')
    const extracted = join(root, 'closure')
    mkdirSync(extracted)
    expect(spawnSync('tar', ['-x', '-z', '-f', ARCHIVE!, '-C', extracted]).status).toBe(0)
    const anchorPath = join(extracted, 'app/node_modules/@deepseek-ai/dsh/package.json')
    const anchor = JSON.parse(readFileSync(anchorPath, 'utf8')) as { dependencies: Record<string, string> }
    expect(Object.keys(anchor.dependencies)).toEqual(expect.arrayContaining(readRecipe().closure.anchor.bundles))
    for (const bundle of readRecipe().closure.anchor.bundles) delete anchor.dependencies[bundle]
    writeFileSync(anchorPath, JSON.stringify(anchor))
    const home = join(root, 'home')
    mkdirSync(home)
    const env = { HOME: home, PATH: `${join(extracted, 'node/bin')}:/usr/bin:/bin`, LANG: 'C.UTF-8', DEEPSEEK_API_KEY: 'sk-closure-boot-spec' }
    const setup = spawnSync(join(extracted, 'node/bin/node'), [join(extracted, 'app/node_modules/@delo/cli/src/bin.js'), 'setup', '--yes'], { cwd: root, env, encoding: 'utf8' })
    expect(setup.status).not.toBe(0)
    expect(`${setup.stdout}${setup.stderr}`).toContain('@delo/bundle-local')
  })
})
