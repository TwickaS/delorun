/**
 * Where an added agent's pinned program is. Each agent's pack (upstream's `@deepseek-ai/dsh-subagent-claude-code` or
 * `@deepseek-ai/dsh-subagent-codex`) brings a pinned copy of the provider's program; this finds it the way the pack
 * itself would, starting from the profile's directory. It loads nothing and starts nothing, so the CLI and the Host's
 * drivers share it.
 * @module @delorun/external-agents/locate
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExternalAgentName } from './contract.ts'

/** The agents a pack can add, by upstream's provider name. */
export const EXTERNAL_AGENTS: readonly ExternalAgentName[] = ['claude-code', 'codex']

/** The name a person knows each agent by, and the package of its pack. */
export const AGENT_PACKS: Readonly<Record<ExternalAgentName, { readonly title: string; readonly pack: string }>> = {
  'claude-code': { title: 'Claude Code', pack: '@deepseek-ai/dsh-subagent-claude-code' },
  'codex': { title: 'Codex', pack: '@deepseek-ai/dsh-subagent-codex' },
}

/** The package that holds the Claude Agent SDK's JavaScript. */
export const CLAUDE_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'

/** The package that holds the Codex launcher script. */
export const CODEX_PACKAGE = '@openai/codex'

/** What the lookup needs to know about the machine. */
export interface Machine {
  /** Node's platform name. */
  readonly platform: NodeJS.Platform
  /** Node's architecture name. */
  readonly arch: string
}

/** One installed package. */
export interface LocatedPackage {
  /** The package's folder, an absolute path. */
  readonly directory: string
  /** The version its `package.json` records. */
  readonly version: string
}

/** The Claude Agent SDK an added pack brings. */
export interface LocatedClaudeSdk extends LocatedPackage {
  /** The file the package's main export resolves to, which a driver loads by dynamic `import()` of its file URL. */
  readonly entry: string
}

/** The Codex launcher an added pack brings. */
export interface LocatedCodex extends LocatedPackage {
  /** The launcher script, run as `node <script> …`. */
  readonly script: string
}

/** A program to run and its arguments. */
export interface LoginProgram {
  /** The program, an absolute path. */
  readonly program: string
  /** Its arguments. */
  readonly args: readonly string[]
}

/**
 * Resolve a specifier from a place, or say it is not there.
 * @param from - a file whose location resolution starts at.
 * @param specifier - what to resolve.
 * @returns the resolved path, or undefined when it cannot be resolved from there.
 * @throws any resolution failure other than an absent package or a path the package does not export.
 */
function resolveFrom(from: string, specifier: string): string | undefined {
  try {
    return createRequire(from).resolve(specifier)
  } catch (error) {
    const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return undefined
    throw error
  }
}

/**
 * Read a package manifest's name, version and `bin`.
 * @param path - the `package.json` file.
 * @returns the fields, or undefined when the file is absent or not a manifest object.
 */
function readManifest(path: string): { readonly name?: unknown; readonly version?: unknown; readonly bin?: unknown } | undefined {
  if (!existsSync(path)) return undefined
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) return undefined
  return { name: Reflect.get(parsed, 'name'), version: Reflect.get(parsed, 'version'), bin: Reflect.get(parsed, 'bin') }
}

/**
 * Walk up from a file inside a package to the folder whose manifest names the package.
 * @param file - a file inside the package.
 * @param name - the package name.
 * @returns the folder, or undefined when no enclosing manifest names the package.
 */
function enclosingPackage(file: string, name: string): string | undefined {
  const { root } = parse(file)
  for (let folder = dirname(file); ; folder = dirname(folder)) {
    if (readManifest(join(folder, 'package.json'))?.name === name) return folder
    if (folder === root) return undefined
  }
}

/**
 * Find an installed package's folder and version from a place. A package whose `exports` map leaves out
 * `./package.json` is found through its main export instead, walking up to its folder.
 * @param from - a file whose location resolution starts at.
 * @param name - the package name.
 * @returns the package, or undefined when it is not installed there or records no version.
 */
export function locatePackage(from: string, name: string): LocatedPackage | undefined {
  const manifest = resolveFrom(from, `${name}/package.json`)
  const directory = manifest !== undefined ? dirname(manifest) : enclosingFromEntry(from, name)
  if (directory === undefined) return undefined
  const version = readManifest(join(directory, 'package.json'))?.version
  return typeof version === 'string' ? { directory, version } : undefined
}

/**
 * @param from - a file whose location resolution starts at.
 * @param name - the package name.
 * @returns the folder of the package whose main export resolves from there, or undefined.
 */
function enclosingFromEntry(from: string, name: string): string | undefined {
  const entry = resolveFrom(from, name)
  return entry === undefined ? undefined : enclosingPackage(entry, name)
}

/**
 * Find an agent's pack from the profile's directory.
 * @param agent - which agent.
 * @param profileDirectory - the profile's directory, where its packages are installed.
 * @returns the pack, or undefined when it is not added.
 */
export function locatePack(agent: ExternalAgentName, profileDirectory: string): LocatedPackage | undefined {
  return locatePackage(join(profileDirectory, 'package.json'), AGENT_PACKS[agent].pack)
}

/**
 * Find the Claude Agent SDK the Claude Code pack brings.
 * @param profileDirectory - the profile's directory.
 * @returns the SDK, or undefined when the pack or the SDK inside it is not installed.
 */
export function locateClaudeSdk(profileDirectory: string): LocatedClaudeSdk | undefined {
  const pack = locatePack('claude-code', profileDirectory)
  if (pack === undefined) return undefined
  const from = join(pack.directory, 'package.json')
  const sdk = locatePackage(from, CLAUDE_SDK_PACKAGE)
  const entry = resolveFrom(from, CLAUDE_SDK_PACKAGE)
  return sdk === undefined || entry === undefined ? undefined : { ...sdk, entry }
}

/**
 * The Claude Agent SDK's platform packages that can hold the program, most likely first.
 * @param machine - the platform and architecture.
 * @returns the package names.
 */
function claudePlatformPackages(machine: Machine): readonly string[] {
  const base = `${CLAUDE_SDK_PACKAGE}-${machine.platform}-${machine.arch}`
  return machine.platform === 'linux' ? [base, `${base}-musl`] : [base]
}

/**
 * Find the native Claude Code program the SDK's platform package brings.
 * @param sdk - the SDK, from {@link locateClaudeSdk}.
 * @param machine - the platform and architecture.
 * @returns the program, an absolute path, or undefined when no platform package for this machine holds it.
 */
export function locateClaudeProgram(sdk: LocatedPackage, machine: Machine): string | undefined {
  for (const name of claudePlatformPackages(machine)) {
    const found = locatePackage(join(sdk.directory, 'package.json'), name)
    if (found === undefined) continue
    const program = join(found.directory, machine.platform === 'win32' ? 'claude.exe' : 'claude')
    if (existsSync(program)) return program
  }
  return undefined
}

/**
 * Find the Codex launcher the Codex pack brings.
 * @param profileDirectory - the profile's directory.
 * @returns the launcher, or undefined when the pack, the package or its `codex` bin is missing.
 */
export function locateCodex(profileDirectory: string): LocatedCodex | undefined {
  const pack = locatePack('codex', profileDirectory)
  if (pack === undefined) return undefined
  const codex = locatePackage(join(pack.directory, 'package.json'), CODEX_PACKAGE)
  if (codex === undefined) return undefined
  const bin = readManifest(join(codex.directory, 'package.json'))?.bin
  const relative: unknown = typeof bin === 'object' && bin !== null ? Reflect.get(bin, 'codex') : bin
  if (typeof relative !== 'string') return undefined
  const script = join(codex.directory, relative)
  return existsSync(script) ? { ...codex, script } : undefined
}

/** Codex's target triples and platform packages by Node platform and architecture, as its launcher `bin/codex.js` maps them. */
const CODEX_TARGETS: Readonly<Record<string, { readonly triple: string, readonly pack: string }>> = {
  'linux-x64': { triple: 'x86_64-unknown-linux-musl', pack: '@openai/codex-linux-x64' },
  'linux-arm64': { triple: 'aarch64-unknown-linux-musl', pack: '@openai/codex-linux-arm64' },
  'darwin-x64': { triple: 'x86_64-apple-darwin', pack: '@openai/codex-darwin-x64' },
  'darwin-arm64': { triple: 'aarch64-apple-darwin', pack: '@openai/codex-darwin-arm64' },
  'win32-x64': { triple: 'x86_64-pc-windows-msvc', pack: '@openai/codex-win32-x64' },
  'win32-arm64': { triple: 'aarch64-pc-windows-msvc', pack: '@openai/codex-win32-arm64' },
}

/**
 * Find the native Codex program the launcher runs, where the launcher looks: the platform package's `vendor` folder,
 * else the Codex package's own.
 * @param codex - the Codex package, from {@link locateCodex}.
 * @param machine - the platform and architecture.
 * @returns the program, an absolute path, or undefined when this machine has no Codex build or none is installed.
 */
export function locateCodexProgram(codex: LocatedPackage, machine: Machine): string | undefined {
  const target = CODEX_TARGETS[`${machine.platform}-${machine.arch}`]
  if (target === undefined) return undefined
  const manifest = resolveFrom(join(codex.directory, 'package.json'), `${target.pack}/package.json`)
  const vendor = manifest === undefined ? join(codex.directory, 'vendor') : join(dirname(manifest), 'vendor')
  const program = join(vendor, target.triple, 'bin', machine.platform === 'win32' ? 'codex.exe' : 'codex')
  return existsSync(program) ? program : undefined
}

/**
 * The executables a live agent's process-group leader runs, as real paths, for reaping only located programs: the Node
 * binary that runs the subprocess runner (see {@link agentScripts} for the scripts it may run), Claude Code's native program
 * and the native Codex program when the added packs bring them.
 * @param profileDirectory - the profile's directory, when known.
 * @param machine - the platform and architecture.
 * @param nodePath - the Node binary the Host runs, `process.execPath`.
 * @returns the paths that exist.
 */
export function agentExecutables(profileDirectory: string | undefined, machine: Machine, nodePath: string): string[] {
  const sdk = profileDirectory === undefined ? undefined : locateClaudeSdk(profileDirectory)
  const claude = sdk === undefined ? undefined : locateClaudeProgram(sdk, machine)
  const codex = profileDirectory === undefined ? undefined : locateCodex(profileDirectory)
  const codexProgram = codex === undefined ? undefined : locateCodexProgram(codex, machine)
  return [...new Set([nodePath, claude, codexProgram].filter((path): path is string => path !== undefined && existsSync(path)).map(path => realpathSync(path)))]
}

/** The specifier of Claude Code's watcher script, which runs under Node as the leader of the program's process group. */
const CLAUDE_WATCHER = '@delorun/agent-claude-code/watcher'

/** The bundle whose dependencies bring the driver packages; the profile installs the bundle, not the driver, so the watcher is found from it. */
const DRIVER_BUNDLE = '@delorun/bundle-local/package.json'

/**
 * The scripts a live agent's Node leader runs, as real paths, for reaping only located programs: the Codex launcher
 * and Claude Code's watcher. The watcher belongs to a Delorun package that depends on this one, so it is found by name
 * from the profile's directory and from this module, and is absent where that package is not installed. The profile installs the bundle that depends on the driver, so
 * resolution also starts from that bundle's manifest.
 * @param profileDirectory - the profile's directory, when known.
 * @param moduleFiles - the files besides the profile's `package.json` that resolution of the watcher starts from.
 * @returns the paths that exist.
 */
export function agentScripts(profileDirectory: string | undefined, moduleFiles: readonly string[] = [fileURLToPath(import.meta.url)]): string[] {
  const codex = profileDirectory === undefined ? undefined : locateCodex(profileDirectory)
  const profileManifest = profileDirectory === undefined ? undefined : join(profileDirectory, 'package.json')
  const bundleManifest = profileManifest === undefined ? undefined : resolveFrom(profileManifest, DRIVER_BUNDLE)
  const starts = [...[profileManifest, bundleManifest].filter((from): from is string => from !== undefined), ...moduleFiles]
  const watcher = starts.map(from => resolveFrom(from, CLAUDE_WATCHER)).find(path => path !== undefined)
  return [...new Set([codex?.script, watcher].filter((path): path is string => path !== undefined && existsSync(path)).map(path => realpathSync(path)))]
}

/**
 * Find the program that signs an added agent in.
 * @param agent - which agent.
 * @param profileDirectory - the profile's directory.
 * @param machine - the platform and architecture.
 * @returns the program and its arguments, or undefined when the agent's pack, or the program inside it, is not installed.
 */
export function loginProgramFor(agent: ExternalAgentName, profileDirectory: string, machine: Machine): LoginProgram | undefined {
  if (agent === 'codex') {
    const codex = locateCodex(profileDirectory)
    return codex === undefined ? undefined : { program: process.execPath, args: [codex.script, 'login'] }
  }
  const sdk = locateClaudeSdk(profileDirectory)
  const program = sdk === undefined ? undefined : locateClaudeProgram(sdk, machine)
  return program === undefined ? undefined : { program, args: ['auth', 'login'] }
}

/**
 * The version of an agent's program as its pack brings it: Claude Code's from the Agent SDK's manifest, Codex's from
 * its package.
 * @param agent - the agent.
 * @param profileDirectory - the profile's directory, where the pack is looked for.
 * @returns the version, or undefined when the pack is not installed or its manifest does not say.
 */
export function programVersion(agent: ExternalAgentName, profileDirectory: string): string | undefined {
  if (agent === 'codex') return locateCodex(profileDirectory)?.version
  const sdk = locateClaudeSdk(profileDirectory)
  if (sdk === undefined) return undefined
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(sdk.directory, 'package.json'), 'utf8'))
  } catch (error: unknown) {
    // The manifest was readable when the SDK was located; without its program version the SDK's own is shown.
    manifest = error
  }
  const program = typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'claudeCodeVersion') : undefined
  return typeof program === 'string' ? program : sdk.version
}
