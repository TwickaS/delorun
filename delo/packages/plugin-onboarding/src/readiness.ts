/**
 * What onboarding reports about this computer before the person decides anything: whether Claude Code and Codex have
 * a sign-in here, and how far Tailscale is from serving the studio to a phone. Every probe only reads: the sign-in
 * probe checks whether a file exists and never opens it, and the Tailscale probe runs `tailscale version`, `tailscale
 * status --json` and `tailscale serve status --json` through an injected runner, never a command that changes anything.
 * @module @delo/plugin-onboarding/readiness
 */
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readServeRules, readTailscale, ReachError, serveTarget, type TailscaleRunner } from '@delo/reach'
import type { AgentSignIn, Readiness, TailscaleReadiness } from './wire.ts'

/** The port `delorun reach on tailscale` serves the studio on, which the serve probe asks about. */
const SERVE_PORT = 443

/** What the probes read: the environment, the home directory and the platform, so specs can place them. */
export interface ReadinessEnvironment {
  /** The environment the harness inherited; `CODEX_HOME` moves Codex's files. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The person's home directory. */
  readonly home: string
  /** `process.platform`. */
  readonly platform: NodeJS.Platform
  /** Runs `tailscale` with arguments. */
  readonly tailscale: TailscaleRunner
}

/**
 * The environment of this process.
 * @param tailscale - the runner.
 * @returns the environment.
 */
export function processReadinessEnvironment(tailscale: TailscaleRunner): ReadinessEnvironment {
  // The process environment boundary: Codex's own home is moved by CODEX_HOME, as Codex reads it.
  return { env: process.env, home: homedir(), platform: process.platform, tailscale }
}

/**
 * @param path - a file.
 * @returns whether a regular file exists there; any failure reads as absent.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (_absent) {
    // A missing or unreadable file is the same answer here: no sign-in this probe can see.
    return false
  }
}

/**
 * Whether Claude Code has a sign-in on this computer. Claude Code keeps it in `~/.claude/.credentials.json`, except on
 * macOS, where it uses the Keychain, which this probe does not read: there a found settings file means it cannot tell.
 * @param environment - where to look.
 * @returns the sign-in state.
 */
export async function claudeSignIn(environment: ReadinessEnvironment): Promise<AgentSignIn> {
  if (await fileExists(join(environment.home, '.claude', '.credentials.json'))) return 'found'
  if (environment.platform === 'darwin' && await fileExists(join(environment.home, '.claude.json'))) return 'unknown'
  return 'missing'
}

/**
 * Whether Codex has a sign-in on this computer: `auth.json` in `CODEX_HOME`, or in `~/.codex`.
 * @param environment - where to look.
 * @returns the sign-in state.
 */
export async function codexSignIn(environment: ReadinessEnvironment): Promise<AgentSignIn> {
  const codexHome = environment.env['CODEX_HOME'] !== undefined && environment.env['CODEX_HOME'] !== '' ? environment.env['CODEX_HOME'] : join(environment.home, '.codex')
  return await fileExists(join(codexHome, 'auth.json')) ? 'found' : 'missing'
}

/**
 * How far Tailscale is from serving the studio: the first thing missing, in the order a person fixes them.
 * @param run - the runner.
 * @returns the state; `ready` names this machine's tailnet name.
 */
export async function tailscaleReadiness(run: TailscaleRunner): Promise<TailscaleReadiness> {
  try {
    const { dnsName } = await readTailscale(run)
    await readServeRules(run, dnsName, SERVE_PORT, serveTarget(0))
    return { state: 'ready', dnsName }
  } catch (error) {
    if (!(error instanceof ReachError)) return { state: 'unknown' }
    switch (error.code) {
      case 'TAILSCALE_NOT_INSTALLED': return { state: 'not-installed' }
      case 'TAILSCALE_NOT_LOGGED_IN': return { state: 'signed-out' }
      case 'TAILSCALE_HTTPS_DISABLED': return { state: 'https-off' }
      case 'TAILSCALE_SERVE_NOT_PERMITTED': return { state: 'needs-operator' }
      // Every other refusal (a conflicting serve rule, Funnel on) is for `delorun reach on tailscale` to name.
      default: return { state: 'unknown' }
    }
  }
}

/**
 * Run every probe.
 * @param environment - where to look and how to run `tailscale`.
 * @returns what onboarding shows.
 */
export async function readReadiness(environment: ReadinessEnvironment): Promise<Readiness> {
  const [claude, codex, tailscale] = await Promise.all([claudeSignIn(environment), codexSignIn(environment), tailscaleReadiness(environment.tailscale)])
  return { agents: { 'claude-code': claude, 'codex': codex }, tailscale }
}
