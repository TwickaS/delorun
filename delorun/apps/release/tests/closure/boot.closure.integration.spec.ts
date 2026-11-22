/**
 * A built runtime closure boots: extracted to an empty directory, its own Node runs `delorun setup --yes` against an
 * empty home with no pnpm on `PATH`, so setup must find Delorun's bundle through the install anchor rather than link
 * it, and then `delorun start --foreground`'s own code starts the CLI profile with the CLI's own profile runner, and
 * every row whose module is a `@delorun/` package is active. The client artifacts carry the title `closure.json` names. It runs only when
 * `DELORUN_CLOSURE_ARCHIVE` names a `linux-x64` closure archive that `build-closure.ts` built (`DELORUN_CLOSURE_EXISTING_ARTIFACTS=1`
 * when it was built with `--artifacts existing`, whose client carries the worktree build's title). A second spec starts the
 * Host as the home process and requests the studio's index on loopback. A third runs `--version` and one command of each
 * top-level command `delorun --help` lists, with neither pnpm nor git on `PATH`, so a module the closure does not carry
 * or a command that crashes instead of refusing fails it.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRecipe } from '../../src/closure/config.ts'
import { scratch } from '../support.ts'

const ARCHIVE = process.env.DELORUN_CLOSURE_ARCHIVE

/** Set when the archive was built with `build-closure.ts --artifacts existing`. */
const EXISTING_ARTIFACTS = process.env.DELORUN_CLOSURE_EXISTING_ARTIFACTS === '1'

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
import { prepareHome } from '@delorun/cli/src/command.js'
import { OPT_IN_ROWS } from '@delorun/cli/src/delorun-bundles.js'
import { CliError } from '@delorun/cli/src/exit.js'
import { profileDirectory } from '@delorun/cli/src/profile.js'
import { startForeground, upstreamDependencies } from '@delorun/cli/src/start.js'
const context = { env: { ...process.env }, stdout: text => void process.stderr.write(text), stderr: text => void process.stderr.write(text) }
const { home, profile } = await prepareHome(context, undefined, true)
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
  await startForeground({ home: home.path, profile, open: false, output: context, env: context.env }, {
    ...cli,
    async runProfile(options) {
      booted = await cli.runProfile(options)
      return booted
    },
  })
  rows = booted.rows()
  process.stdout.write(JSON.stringify({ outcome: 'started', rows, optIn: [...OPT_IN_ROWS] }) + '\\n')
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
  it('sets up a new home without linking, starts the CLI profile with every Delorun row active except the opt-in ones, and presents the closure\'s title', (test) => {
    const root = scratch(test, 'delorun-closure-boot-')
    const extracted = join(root, 'closure')
    mkdirSync(extracted)
    const unpack = spawnSync('tar', ['-x', '-z', '-f', ARCHIVE!, '-C', extracted], { encoding: 'utf8', timeout: 120_000 })
    expect(unpack.stderr).toBe('')
    expect(unpack.status, `signal ${String(unpack.signal)}: ${unpack.stderr}`).toBe(0)
    const node = join(extracted, 'node/bin/node')
    const home = join(root, 'home')
    mkdirSync(home)
    const env = { HOME: home, PATH: `${join(extracted, 'node/bin')}:/usr/bin:/bin`, LANG: 'C.UTF-8', DEEPSEEK_API_KEY: 'sk-closure-boot-spec' }
    expect(spawnSync('sh', ['-c', 'command -v pnpm'], { env, encoding: 'utf8', timeout: 30_000 }).status).not.toBe(0)

    const setup = spawnSync(node, [join(extracted, 'app/node_modules/@delorun/cli/src/bin.js'), 'setup', '--yes'], { cwd: root, env, encoding: 'utf8', timeout: 300_000 })
    expect(setup.stderr).not.toContain('Error')
    expect(setup.status, `signal ${String(setup.signal)}: ${setup.stderr}`).toBe(0)
    const links = packageJsonFiles(join(home, '.delorun')).filter(path => readFileSync(path, 'utf8').includes('"link:'))
    expect(links).toEqual([])

    const driver = join(extracted, 'app/delorun-boot-driver.mjs')
    writeFileSync(driver, START_DRIVER)
    const start = spawnSync(node, [driver], { cwd: root, env, encoding: 'utf8', timeout: 120_000 })
    const report = JSON.parse(start.stdout.trim().split('\n').at(-1) ?? '{}') as { outcome?: string, message?: string, rows?: Array<{ id: string, name: string, state: string, disabled?: boolean }>, optIn?: string[] }
    expect(report.message).toBeUndefined()
    expect(report.outcome).toBe('started')
    expect(start.status, `signal ${String(start.signal)}: ${start.stderr}`).toBe(0)
    const delorun = (report.rows ?? []).filter(row => row.name.startsWith('@delorun/'))
    expect(delorun.map(row => row.id)).toContain('delorun-privacy')
    // An opt-in row (the CLI's OPT_IN_ROWS) is inserted disabled; every other Delorun row is active.
    expect(delorun.filter(row => row.state !== 'active' && !(row.disabled === true && report.optIn?.includes(row.id) === true))).toEqual([])

    // A closure built from existing artifacts carries the title the worktree's own artifact build used.
    if (EXISTING_ARTIFACTS) return
    const title = readRecipe().closure.clientTitle
    const dist = join(extracted, 'app/node_modules/@deepseek-ai/dsh-web-frontend/dist')
    const html = readFileSync(join(dist, 'index.html'), 'utf8')
    expect(html).toContain(`<title>${title}</title>`)
    expect(html).toContain(`<meta name="apple-mobile-web-app-title" content="${title}" />`)
    if (existsSync(join(dist, 'manifest.webmanifest'))) expect(JSON.parse(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8')).name).toBe(title)
  })

  it('starts the Host in the home process and serves the studio\'s index on loopback to a client with a one-time link from delorun open', async (test) => {
    const root = scratch(test, 'delorun-closure-serve-')
    const extracted = join(root, 'closure')
    mkdirSync(extracted)
    execFileSync('tar', ['-x', '-z', '-f', ARCHIVE!, '-C', extracted], { timeout: 120_000 })
    const node = join(extracted, 'node/bin/node')
    const home = join(root, 'home')
    mkdirSync(home)
    const env = { HOME: home, PATH: `${join(extracted, 'node/bin')}:/usr/bin:/bin`, LANG: 'C.UTF-8', DEEPSEEK_API_KEY: 'sk-closure-boot-spec' }
    const entry = join(extracted, 'app/node_modules/@delorun/cli/src/bin.js')
    execFileSync(node, [entry, 'setup', '--yes'], { cwd: root, env, encoding: 'utf8', timeout: 300_000 })
    const version = spawnSync(node, [entry, '--version'], { cwd: root, env, encoding: 'utf8', timeout: 50_000 })
    expect(version.stdout, `signal ${String(version.signal)}: ${version.stderr}`).toMatch(/^Delorun \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\nDSH \d+\.\d+\.\d+/u)
    // The default port belongs to whichever Host runs on this computer, so the profile asks the system for one.
    const bundle = readFileSync(join(extracted, 'app/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml'), 'utf8').split('\n')
    const indent = (line: string): number => line.length - line.trimStart().length
    const row = bundle.findIndex(line => line.trim() === '- id: webserver')
    const config = bundle.findIndex((line, index) => index > row && line.trim() === 'config:')
    const block: string[] = []
    for (const line of bundle.slice(config + 1)) {
      if (line.trim() === '' || indent(line) <= indent(bundle[config]!)) break
      block.push(line.slice(indent(bundle[config]!) + 2))
    }
    expect(block.filter(line => line.startsWith('port:'))).toHaveLength(1)
    appendFileSync(join(home, '.delorun/profiles/default/cordis.patch.yml'), ['- id: webserver', '  config:', ...block.map(line => line.startsWith('port:') ? '    port: 0' : `    ${line}`), ''].join('\n'))
    const host = spawn(node, [entry, 'start', '--foreground'], { cwd: root, env })
    test.onTestFinished(() => { host.kill('SIGKILL') })
    let output = ''
    const running = new Promise<void>((resolve, reject) => {
      host.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.includes('Run delorun open to open the studio in your browser.') && output.includes('dsh web: ')) resolve()
      })
      host.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
      host.on('exit', () => { reject(new Error(`the Host ended before it served: ${output}`)) })
    })
    await running
    // The start prints the studio's address without a token; `delorun open --print` asks the home process for a link.
    expect(output).toMatch(/dsh web: http:\/\/127\.0\.0\.1:\d+\/?\n/u)
    expect(output).not.toContain('token=')
    const printed = spawnSync(node, [entry, 'open', '--print'], { cwd: root, env, encoding: 'utf8', timeout: 50_000 })
    expect(printed.status, `signal ${String(printed.signal)}: ${printed.stderr}`).toBe(0)
    const url = printed.stdout.split('\n')[0]!
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]{43}$/u)
    // The one-time token is exchanged for a cookie by a redirect, once; a request without either is refused.
    const served = await fetch(url, { redirect: 'manual' })
    expect(served.status).toBe(303)
    expect((await fetch(url, { redirect: 'manual' })).status).toBe(401)
    const cookie = (served.headers.get('set-cookie') ?? '').split(';')[0]!
    const index = await fetch(new URL('/', url), { headers: { cookie } })
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toContain('text/html')
    const html = await index.text()
    expect(html).toContain('<div id="root"></div>')
    expect((await fetch(new URL('/', url))).status).toBe(401)
  })

  it('runs --version and one command of every top-level command, each ending in an answer or a readable refusal', (test) => {
    const root = scratch(test, 'delorun-closure-commands-')
    const extracted = join(root, 'closure')
    mkdirSync(extracted)
    expect(spawnSync('tar', ['-x', '-z', '-f', ARCHIVE!, '-C', extracted], { timeout: 300_000 }).status).toBe(0)
    const home = join(root, 'home')
    mkdirSync(home)
    // No pnpm and no git on PATH: what a command needs of them, the closure carries or the command refuses by name.
    const env = { HOME: home, PATH: `${join(extracted, 'node/bin')}:/nonexistent`, LANG: 'C.UTF-8', DEEPSEEK_API_KEY: 'sk-closure-boot-spec' }
    const node = join(extracted, 'node/bin/node')
    const entry = join(extracted, 'app/node_modules/@delorun/cli/src/bin.js')
    const run = (args: readonly string[]): { readonly status: number | null, readonly output: string } => {
      const result = spawnSync(node, [entry, ...args], { cwd: root, env, encoding: 'utf8', timeout: 120_000 })
      return { status: result.status, output: `${result.stdout}${result.stderr}` }
    }
    expect(run(['setup', '--yes']).status).toBe(0)
    expect(run(['--version']).output).toMatch(/^Delorun \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\nDSH \d+\.\d+\.\d+/u)
    // One invocation per command that needs no running home process and changes nothing outside the scratch home.
    const invocations: Readonly<Record<string, readonly string[]>> = {
      setup: ['setup', '--list'],
      start: ['start', '--no-such-option'],
      stop: ['stop'],
      status: ['status', '--json'],
      doctor: ['doctor', '--help'],
      logs: ['logs'],
      update: ['update', '--check'],
      recover: ['recover', 'status'],
      changes: ['changes'],
      trash: ['trash', 'list'],
      export: ['export'],
      import: ['import'],
      verify: ['verify', '--offline', '--json'],
      plugin: ['plugin', '--profile', 'default', 'list'],
      headless: ['headless', '--help'],
      'import-home': ['import-home', '--dry-run'],
      open: ['open', '--print'],
      reach: ['reach', 'status'],
      devices: ['devices', 'list'],
      mcp: ['mcp', 'list'],
      workspace: ['workspace', 'full-access'],
      agents: ['agents', '--help'],
      preview: ['preview', 'list'],
    }
    const help = run(['--help']).output
    // The help lists the commands in groups, each command at a two-space indent; the words and exit codes follow them.
    const listed = help.slice(0, help.indexOf('Words used here')).split('\n').map(line => /^ {2}(\S+) /u.exec(line)?.[1]).filter(name => name !== undefined)
    expect(listed.sort()).toEqual(Object.keys(invocations).sort())
    const crashed = /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|^\s+at .+:\d+:\d+\)?$/mu
    const failures = Object.entries(invocations).flatMap(([command, args]) => {
      const { status, output } = run(args)
      return status === null || status > 3 || crashed.test(output) ? [`delorun ${args.join(' ')} (${command}) exited ${String(status)}:\n${output}`] : []
    })
    expect(failures).toEqual([])
    // `plugin` runs the closure's own pnpm, which no PATH here provides.
    expect(run(['plugin', '--profile', 'default', 'list']).status).toBe(0)
  })

  it('needs the install anchor\'s declaration: without it, setup cannot make Delorun\'s bundle importable', (test) => {
    const root = scratch(test, 'delorun-closure-anchor-')
    const extracted = join(root, 'closure')
    mkdirSync(extracted)
    execFileSync('tar', ['-x', '-z', '-f', ARCHIVE!, '-C', extracted], { timeout: 120_000 })
    const anchorPath = join(extracted, 'app/node_modules/@deepseek-ai/dsh/package.json')
    const anchor = JSON.parse(readFileSync(anchorPath, 'utf8')) as { dependencies: Record<string, string> }
    expect(Object.keys(anchor.dependencies)).toEqual(expect.arrayContaining(readRecipe().closure.anchor.bundles))
    for (const bundle of readRecipe().closure.anchor.bundles) delete anchor.dependencies[bundle]
    writeFileSync(anchorPath, JSON.stringify(anchor))
    const home = join(root, 'home')
    mkdirSync(home)
    const env = { HOME: home, PATH: `${join(extracted, 'node/bin')}:/usr/bin:/bin`, LANG: 'C.UTF-8', DEEPSEEK_API_KEY: 'sk-closure-boot-spec' }
    const setup = spawnSync(join(extracted, 'node/bin/node'), [join(extracted, 'app/node_modules/@delorun/cli/src/bin.js'), 'setup', '--yes'], { cwd: root, env, encoding: 'utf8', timeout: 300_000 })
    expect(setup.status, `signal ${String(setup.signal)}: ${setup.stderr}`).not.toBe(0)
    expect(`${setup.stdout}${setup.stderr}`).toContain('@delorun/bundle-local')
  })
})
