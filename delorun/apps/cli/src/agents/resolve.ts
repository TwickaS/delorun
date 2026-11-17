/**
 * Where an added agent's own program is, so its sign-in can run without a separately installed command. Each agent's
 * package brings a pinned copy of the provider's program; this finds it the way the package itself would, starting from
 * the profile's directory.
 *
 * @module @delorun/cli/agents/resolve
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

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
 * @returns the resolved path, or undefined when it cannot be resolved from there.
 */
function resolveFrom(from: string, specifier: string): string | undefined {
  try {
    return createRequire(from).resolve(specifier)
  } catch (_absent) {
    // The package is not installed where resolution looks, which is the answer.
    return undefined
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
  const pack = resolveFrom(join(profileDirectory, 'package.json'), `${AGENT_LOGIN[agent].pack}/package.json`)
  if (pack === undefined) return undefined
  if (agent === 'codex') {
    const manifest = resolveFrom(pack, '@openai/codex/package.json')
    if (manifest === undefined) return undefined
    const bin: unknown = (JSON.parse(readFileSync(manifest, 'utf8')) as { readonly bin?: unknown }).bin
    const relative = typeof bin === 'object' && bin !== null ? Reflect.get(bin, 'codex') : bin
    if (typeof relative !== 'string') return undefined
    return { program: process.execPath, args: [join(dirname(manifest), relative), 'login'] }
  }
  const sdk = resolveFrom(pack, '@anthropic-ai/claude-agent-sdk/package.json')
  if (sdk === undefined) return undefined
  for (const name of claudePlatformPackages(machine)) {
    const manifest = resolveFrom(sdk, `${name}/package.json`)
    if (manifest === undefined) continue
    const program = join(dirname(manifest), machine.platform === 'win32' ? 'claude.exe' : 'claude')
    if (existsSync(program)) return { program, args: ['auth', 'login'] }
  }
  return undefined
}
