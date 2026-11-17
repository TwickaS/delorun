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

/**
 * The executables a live agent's process-group leader runs, as real paths, for reaping only located programs: the Node
 * binary that runs the subprocess runner, the Codex launcher and Claude Code's watcher, and Claude Code's native
 * program when the added pack brings one.
 * @param profileDirectory - the profile's directory, when known.
 * @param machine - the platform and architecture.
 * @param nodePath - the Node binary the Host runs, `process.execPath`.
 * @returns the paths that exist.
 */
export function agentExecutables(profileDirectory: string | undefined, machine: Machine, nodePath: string): string[] {
  const sdk = profileDirectory === undefined ? undefined : locateClaudeSdk(profileDirectory)
  const claude = sdk === undefined ? undefined : locateClaudeProgram(sdk, machine)
  return [...new Set([nodePath, claude].filter((path): path is string => path !== undefined && existsSync(path)).map(path => realpathSync(path)))]
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
