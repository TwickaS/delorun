/**
 * A Delo home installed in a throwaway root the way a person installs one: the run's launcher installs the channel's
 * current release and runs `delorun setup --yes`. The profile then gets one patch row that moves the studio's web
 * server to a port the system assigns, as the closure boot spec does, because the default port belongs to whichever
 * Host already runs on the machine. Commands run through the launcher, which checks the installed runtime before each
 * start, as a person's `delorun` does.
 *
 * @module @delo/benchmarks/fixtures/home
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { childEnvironment, type BenchRoot } from '../harness/roots.ts'
import { expectSuccess, run, start, type Finished, type ProcessRequest, type Running } from '../harness/processes.ts'

/** A placeholder model key: setup asks for one, and no benchmark sends a request to a model. */
export const PLACEHOLDER_KEY = 'sk-benchmark-placeholder-never-sent'

/** The profile every suite uses. */
export const PROFILE = 'default'

/** A home in a root, with the launcher that serves it. */
export interface InstalledHome {
  /** The root. */
  readonly root: BenchRoot
  /** The launcher's entry file. */
  readonly launcher: string
}

/**
 * The environment of a `delorun` command in a root.
 * @param root - the root.
 * @returns the environment, with the harness's Node first on `PATH` for the launcher.
 */
export function deloEnvironment(root: BenchRoot): NodeJS.ProcessEnv {
  return childEnvironment(root, [dirname(process.execPath)], { DEEPSEEK_API_KEY: PLACEHOLDER_KEY })
}

/**
 * The request that runs `delorun <args>` through the launcher.
 * @param home - the home.
 * @param args - the arguments for `delorun`.
 * @param timeoutMs - the deadline.
 * @param extra - other request fields.
 * @returns the request.
 */
export function deloRequest(home: InstalledHome, args: readonly string[], timeoutMs: number, extra: Partial<ProcessRequest> = {}): ProcessRequest {
  return { command: process.execPath, args: [home.launcher, ...args], env: deloEnvironment(home.root), cwd: home.root.home, timeoutMs, ...extra }
}

/**
 * Run `delorun <args>` through the launcher.
 * @param home - the home.
 * @param args - the arguments.
 * @param timeoutMs - the deadline.
 * @returns how it finished.
 */
export async function delorun(home: InstalledHome, args: readonly string[], timeoutMs = 300_000): Promise<Finished> {
  return run(deloRequest(home, args, timeoutMs))
}

/**
 * The installed runtime directory of a version.
 * @param root - the root.
 * @param version - the version.
 * @returns `<home>/.delo/runtimes/<version>`, resolved.
 */
export function runtimeDirectory(root: BenchRoot, version: string): string {
  return realpathSync(join(root.deloHome, 'runtimes', version))
}

/**
 * Move the profile's studio to a system-assigned port: a `webserver` patch row with the installed web app bundle's own
 * configuration and `port: 0`.
 * @param root - the root.
 * @param version - the installed version whose web app bundle declares the row.
 * @throws {Error} when the bundle has no `webserver` row with one port setting.
 */
export function patchStudioPort(root: BenchRoot, version: string): void {
  const bundle = readFileSync(join(runtimeDirectory(root, version), 'app/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml'), 'utf8').split('\n')
  const indent = (line: string): number => line.length - line.trimStart().length
  const row = bundle.findIndex(line => line.trim() === '- id: webserver')
  const config = bundle.findIndex((line, index) => index > row && line.trim() === 'config:')
  const block: string[] = []
  for (const line of bundle.slice(config + 1)) {
    if (line.trim() === '' || indent(line) <= indent(bundle[config]!)) break
    block.push(line.slice(indent(bundle[config]!) + 2))
  }
  if (row < 0 || config < 0 || block.filter(line => line.startsWith('port:')).length !== 1) throw new Error('the web app bundle has no webserver row with one port setting')
  appendFileSync(join(root.deloHome, 'profiles', PROFILE, 'cordis.patch.yml'), ['- id: webserver', '  config:', ...block.map(line => line.startsWith('port:') ? '    port: 0' : `    ${line}`), ''].join('\n'))
}

/**
 * Install the channel's current release into a root's home and set the CLI profile up.
 * @param root - the root.
 * @param launcher - the launcher's entry file.
 * @param version - the version the channel names.
 * @returns the home, and how the install and setup finished.
 * @throws {Error} when the launcher or setup fails.
 */
export async function installHome(root: BenchRoot, launcher: string, version: string): Promise<{ readonly home: InstalledHome, readonly setup: Finished }> {
  const home = { root, launcher }
  const setup = expectSuccess(await delorun(home, ['setup', '--yes'], 900_000), 'the launcher install and setup')
  patchStudioPort(root, version)
  return { home, setup }
}

/**
 * Copy an installed home into another root, keeping modes, links and times.
 * @param from - the template root.
 * @param to - the new root.
 */
export function copyHome(from: BenchRoot, to: BenchRoot): void {
  execFileSync('cp', ['-a', `${from.home}/.`, to.home])
}

/**
 * Start the home process for a root with a driver module run by an installed runtime's Node from that runtime's modules:
 * the driver is copied into `<root>/driver/`, whose `node_modules` links to the runtime's `app/node_modules`.
 * @param home - the home.
 * @param version - the installed version whose Node and modules run the driver.
 * @param driver - the driver module's file.
 * @param args - its arguments.
 * @param timeoutMs - the deadline for the whole process.
 * @returns the running driver.
 */
export function startDriver(home: InstalledHome, version: string, driver: string, args: readonly string[], timeoutMs: number): Running {
  const runtime = runtimeDirectory(home.root, version)
  const directory = join(home.root.path, `driver-${version}`)
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'driver.mjs')
  copyFileSync(driver, file)
  try {
    symlinkSync(join(runtime, 'app', 'node_modules'), join(directory, 'node_modules'))
  } catch (_exists) {
    // A second start in the same root reuses the link.
  }
  return start({
    command: join(runtime, 'node', 'bin', 'node'),
    args: [file, ...args],
    env: { ...deloEnvironment(home.root), DSH_HOME: home.root.deloHome, DELO_HOME: home.root.deloHome, DELO_PROFILE: PROFILE },
    cwd: home.root.home,
    timeoutMs,
  })
}

/**
 * Stop the home process of a root, and kill every process that still runs from the root.
 * @param home - the home.
 */
export async function stopHome(home: InstalledHome): Promise<void> {
  await delorun(home, ['stop', '--now'], 120_000)
  await killLeftovers(home.root)
}

/**
 * Kill every process whose command line names the root.
 * @param root - the root.
 */
export async function killLeftovers(root: BenchRoot): Promise<void> {
  const found = await run({ command: 'pgrep', args: ['-f', root.path], env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 10_000 })
  for (const line of found.lines) {
    const pid = Number(line.text.trim())
    if (!Number.isSafeInteger(pid) || pid === process.pid) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch (_gone) {
      // ESRCH: it ended between the listing and the kill.
    }
  }
}
