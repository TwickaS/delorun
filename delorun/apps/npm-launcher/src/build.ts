/**
 * Builds the launcher into the package npm publishes as `delorun`, and packs it:
 *
 * `node_modules/.bin/tsx delorun/apps/npm-launcher/src/build.ts --root <root.json>... --out <dir> [--channel-origin <origin>]
 * [--log-origin <origin>] [--package-version <version>]`
 *
 * The build bundles the launcher and the workspace packages it uses into plain JavaScript with no dependencies, so
 * `npx` runs it on Node alone. Each `--root` is copied into the package's `roots/` directory under the name its own
 * version gives, after it verifies with its own root signatures, and the roots together must start at any version and
 * rise by one; a build with no root is refused, because the launcher it made would refuse every install. The channel
 * and log origins become build constants the bundler writes into the code (see `platform.ts`); without them the build
 * is the production launcher. The package is staged at `<out>/package` and packed to `<out>/delorun-<version>.tgz`.
 * Before it packs, the build scans the whole output folder for the building user's home directory, user name as a
 * folder and unique build root (`@delorun/release-formats/gate/home-paths`) and refuses, naming each file, so no tarball
 * is written; there is no flag that skips the scan.
 *
 * @module @delorun/npm-launcher/build
 */
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { build } from 'tsdown'
import { RELEASE_REPOSITORY_URL } from '@delorun/contract-release-manifest'
import { messageOf } from '@delorun/install'
import { refuseHomePaths, type BuilderIdentity } from '@delorun/release-formats/gate/home-paths'
import { readRoot } from '@delorun/release-formats/sign/verify'
import { MINIMUM_NODE, NODE_ENGINES_RANGE } from './node-version.ts'
import { buildOrigin } from '@delorun/install'
import { channelPlan, logPlan, type BuildConstants } from './platform.ts'
import { readEmbeddedRoots, ROOTS_DIRECTORY } from './root.ts'

const run = promisify(execFile)

/** This package's directory. */
const PACKAGE_DIRECTORY = dirname(dirname(fileURLToPath(import.meta.url)))

/** The repository root, whose `tsconfig.base.json` maps workspace packages to their sources for the bundler. */
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, '..', '..', '..')

/** What a build is given. */
export interface BuildOptions {
  /** The root files the launcher ships, as paths; at least one. */
  readonly roots: readonly string[]
  /** An empty or absent directory the package and the tarball are written to. */
  readonly out: string
  /** The channel and log origins to build in; the production ones by default. */
  readonly constants?: BuildConstants
  /** The npm package version; this package's own by default. */
  readonly version?: string
  /** The building user the home-path scan looks for; this computer's user by default. Tests give another. */
  readonly builder?: BuilderIdentity
}

/** What a build made. */
export interface BuiltLauncher {
  /** The staged package, whose `bin`, `dist/` and `roots/` are what the tarball holds. */
  readonly directory: string
  /** The tarball `npm pack` wrote. */
  readonly tarball: string
}

/** The address of Delorun's issue tracker, which the published package's `bugs` field names. */
const ISSUES_URL = `${RELEASE_REPOSITORY_URL}/issues`

/** The README npm shows for the published package. */
const PUBLISHED_README = `# delorun

**Your harness. No limits.** Delorun is an open-source agent harness that runs on your own computer and that you shape to the way you work. Change anything; undo everything.

\`\`\`sh
npx delorun
\`\`\`

This package is the launcher. It installs Delorun from its release channel, checks the release against its signed manifest and the release log, and installs nothing when either check refuses. It needs Node ${MINIMUM_NODE[0]}.${MINIMUM_NODE[1]} or newer, on Linux or on Windows through WSL2.

- Website: https://delorun.com
- Docs: https://docs.delorun.com
- Source and issues: ${RELEASE_REPOSITORY_URL}

Delorun is an independent, community-driven continuation of DeepSeek Harness. It is not a DeepSeek product, and DeepSeek does not endorse it. MIT licence.
`

/**
 * The manifest of the published package.
 * @param version - the package version.
 * @param constants - the build's origins, so the description says which channel the build serves.
 * @returns the `package.json` text.
 */
function publishedManifest(version: string, constants: BuildConstants): string {
  const custom = constants.channelOrigin !== undefined || constants.logOrigin !== undefined
  return `${JSON.stringify({
    name: 'delorun',
    version,
    description: custom ? 'Delorun launcher built for a local release channel' : 'Install and run Delorun',
    keywords: ['delorun', 'agent-harness', 'ai-agents', 'coding-agent', 'deepseek-harness', 'dsh-plugin', 'cli'],
    homepage: 'https://delorun.com',
    bugs: { url: ISSUES_URL },
    license: 'MIT',
    type: 'module',
    bin: { delorun: 'dist/bin.js' },
    files: ['dist', ROOTS_DIRECTORY, 'LICENSE', 'README.md'],
    engines: { node: NODE_ENGINES_RANGE },
    repository: { type: 'git', url: `git+${RELEASE_REPOSITORY_URL}.git` },
  }, undefined, 2)}\n`
}

/**
 * Copy the root files into a package's `roots/` directory, named by each root's own version.
 * @param paths - the root files.
 * @param stage - the staged package.
 * @returns the root files as the launcher will read them, oldest first, after they verified as a chain.
 * @throws {Error} when no root is given, a root does not verify, or two roots share a version.
 */
async function stageRoots(paths: readonly string[], stage: string): Promise<readonly Uint8Array[]> {
  if (paths.length === 0) throw new Error('pass at least one --root <root file>: a launcher without a root refuses every install')
  const directory = join(stage, ROOTS_DIRECTORY)
  await mkdir(directory, { recursive: true })
  const seen = new Set<number>()
  for (const path of paths) {
    const bytes = await readFile(path)
    const version = readRoot(bytes).metadata.version
    if (seen.has(version)) throw new Error(`two --root files are root version ${String(version)}`)
    seen.add(version)
    await writeFile(join(directory, `${String(version)}.root.json`), bytes)
  }
  return readEmbeddedRoots(stage)
}

/**
 * Build and pack the launcher.
 * @param options - the roots, the output directory, the origins and the version.
 * @returns the staged package and its tarball.
 * @throws {Error} when an origin or a root is refused, the output directory already holds a package, a file of the
 *   output names the builder's paths, or the bundler or `npm pack` fails; an `InstallError` when the roots do not form a chain.
 */
export async function buildLauncher(options: BuildOptions): Promise<BuiltLauncher> {
  const constants = options.constants ?? {}
  // The same functions the launcher runs at start refuse a bad origin here, before anything is written.
  channelPlan(constants)
  if (constants.logOrigin !== undefined) buildOrigin(constants.logOrigin, 'log origin')
  const version = options.version ?? (JSON.parse(await readFile(join(PACKAGE_DIRECTORY, 'package.json'), 'utf8')) as { version: string }).version
  const out = resolve(options.out)
  const stage = join(out, 'package')
  await mkdir(out, { recursive: true })
  try {
    await mkdir(stage)
  } catch (error) {
    throw new Error(`${stage} exists; build into a new directory`, { cause: error })
  }
  const shipped = await stageRoots(options.roots.map(path => resolve(path)), stage)
  // The log a production build reads is the one the newest root names, so that name has to be a host.
  logPlan(readRoot(shipped.at(-1)!).metadata.log.origin, constants)
  await build({
    config: false,
    cwd: REPOSITORY_ROOT,
    entry: { bin: join(PACKAGE_DIRECTORY, 'src', 'entry.ts') },
    outDir: join(stage, 'dist'),
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    tsconfig: join(REPOSITORY_ROOT, 'tsconfig.base.json'),
    deps: { alwaysBundle: [/^(?!node:)/u] },
    define: { __DELORUN_LAUNCHER_BUILD__: JSON.stringify(constants) },
    logLevel: 'warn',
  })
  await writeFile(join(stage, 'package.json'), publishedManifest(version, constants))
  await copyFile(join(PACKAGE_DIRECTORY, 'LICENSE'), join(stage, 'LICENSE'))
  await writeFile(join(stage, 'README.md'), PUBLISHED_README)
  // A path in the package would publish who built it; this refuses before `npm pack` writes a tarball.
  await refuseHomePaths(out, options.builder)
  await run('npm', ['pack', '--pack-destination', out, '--silent'], { cwd: stage })
  return { directory: stage, tarball: join(out, `delorun-${version}.tgz`) }
}

/**
 * The command line.
 * @param argv - the arguments after the script.
 * @returns the exit code: 0 when the tarball was written, 1 when the build refused or failed.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      'root': { type: 'string', multiple: true },
      'out': { type: 'string' },
      'channel-origin': { type: 'string' },
      'log-origin': { type: 'string' },
      'package-version': { type: 'string' },
    },
  })
  try {
    if (values.out === undefined) throw new Error('pass --out <dir> and at least one --root <root file>')
    const built = await buildLauncher({
      roots: values.root ?? [],
      out: values.out,
      constants: {
        ...values['channel-origin'] === undefined ? {} : { channelOrigin: values['channel-origin'] },
        ...values['log-origin'] === undefined ? {} : { logOrigin: values['log-origin'] },
      },
      ...values['package-version'] === undefined ? {} : { version: values['package-version'] },
    })
    console.log(`build: wrote ${built.tarball}`)
    return 0
  } catch (error) {
    console.error(`build: ${messageOf(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
