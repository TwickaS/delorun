/**
 * Where an added agent's own program is, so its sign-in can run without a separately installed command. Each agent's
 * package brings a pinned copy of the provider's program; this finds it the way the package itself would, starting from
 * the profile's directory.
 *
 * @module @delorun/cli/agents/resolve
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, parse } from 'node:path'

/** The agents whose sign-in the command runs, by connection id. */
export const LOGIN_AGENTS = ['claude-code', 'codex'] as const

/** An agent's connection id. */
export type LoginAgent = typeof LOGIN_AGENTS[number]

/** What the command knows about each agent. */
export const AGENT_LOGIN: Readonly<Record<LoginAgent, { readonly title: string; readonly pack: string }>> = {
  'claude-code': { title: 'Claude Code', pack: '@deepseek-ai/dsh-subagent-claude-code' },
  'codex': { title: 'Codex', pack: '@deepseek-ai/dsh-subagent-codex' },
}

/** A program to run and its arguments. */
export interface LoginProgram {
  /** The program, an absolute path. */
  readonly program: string
  /** Its arguments. */
  readonly args: readonly string[]
}

/** What the lookup needs to know about the machine. */
export interface Machine {
  /** Node's platform name. */
  readonly platform: NodeJS.Platform
  /** Node's architecture name. */
  readonly arch: string
}

/**
 * Resolve a file from a place, or say it is not there.
 * @param from - a file whose location resolution starts at.
 * @param specifier - what to resolve.
 * @returns the resolved path, or undefined when the package is absent or does not export the path.
 * @throws any other resolution failure, so a broken install is not reported as a missing package.
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
 * Find an installed package's `package.json` from a place. A package whose `exports` map leaves out `./package.json`
 * is found through its main export instead, walking up to the folder whose manifest carries the package's name.
 * @param from - a file whose location resolution starts at.
 * @param name - the package name.
 * @returns the manifest path, or undefined when the package is not installed there.
 */
function manifestOf(from: string, name: string): string | undefined {
  const direct = resolveFrom(from, `${name}/package.json`)
  if (direct !== undefined) return direct
  const entry = resolveFrom(from, name)
  if (entry === undefined) return undefined
  const { root } = parse(entry)
  for (let folder = dirname(entry); ; folder = dirname(folder)) {
    const manifest = join(folder, 'package.json')
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, 'utf8')) as { readonly name?: unknown }).name === name) return manifest
    if (folder === root) return undefined
  }
}

/**
 * The Claude Agent SDK's platform packages that can hold the program, most likely first.
 * @param machine - the platform and architecture.
 * @returns the package names.
 */
function claudePlatformPackages(machine: Machine): readonly string[] {
  const base = `@anthropic-ai/claude-agent-sdk-${machine.platform}-${machine.arch}`
  return machine.platform === 'linux' ? [base, `${base}-musl`] : [base]
}

/**
 * Find the program that signs an added agent in.
 * @param agent - which agent.
 * @param profileDirectory - the CLI profile's directory, where its packages are installed.
 * @param machine - the platform and architecture.
 * @returns the program and its arguments, or undefined when the agent's package, or the program inside it, is not installed.
 */
export function loginProgramFor(agent: LoginAgent, profileDirectory: string, machine: Machine): LoginProgram | undefined {
  const pack = manifestOf(join(profileDirectory, 'package.json'), AGENT_LOGIN[agent].pack)
  if (pack === undefined) return undefined
  if (agent === 'codex') {
    const manifest = manifestOf(pack, '@openai/codex')
    if (manifest === undefined) return undefined
    const bin: unknown = (JSON.parse(readFileSync(manifest, 'utf8')) as { readonly bin?: unknown }).bin
    const relative = typeof bin === 'object' && bin !== null ? Reflect.get(bin, 'codex') : bin
    if (typeof relative !== 'string') return undefined
    return { program: process.execPath, args: [join(dirname(manifest), relative), 'login'] }
  }
  const sdk = manifestOf(pack, '@anthropic-ai/claude-agent-sdk')
  if (sdk === undefined) return undefined
  for (const name of claudePlatformPackages(machine)) {
    const manifest = manifestOf(sdk, name)
    if (manifest === undefined) continue
    const program = join(dirname(manifest), machine.platform === 'win32' ? 'claude.exe' : 'claude')
    if (existsSync(program)) return { program, args: ['auth', 'login'] }
  }
  return undefined
}
