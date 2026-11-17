/**
 * Opening the studio (contract C19, `studio.open-token`; contract C4, "Loopback sessions"): `delorun` asks the
 * profile's running home process over its update channel for a fresh sign-in link and hands it to the computer's
 * browser. With Delorun's composition the link's token works once and for at most 60 seconds, so the copy that the
 * browser launcher's command line exposes is worthless once the browser has used it. `delorun open`, `delorun start`,
 * a bare `delorun` and setup's ending all open the studio this way; none reads an address from a log, and nothing
 * here prints, logs or reports the link except `delorun open --print`.
 *
 * @module @delorun/cli/open/studio
 */
import { spawn } from 'node:child_process'
import { canOpenNativePath } from '@deepseek-ai/dsh-native-command'
import { HOME_STATUS_TIMEOUT_MS } from '@delorun/contract-home-layout'
import type { StudioLink } from '@delorun/contract-home-process'
import { sendHomeRequest } from '@delorun/home-process'
import { notRunningText } from '../messages.ts'
import { cliRedactor } from '../refusals.ts'

/**
 * Run a command and report its exit code.
 * @param command - the program.
 * @param args - its arguments.
 * @param stdio - where its input and output go.
 * @returns its exit code; 127 when it could not start or a signal ended it.
 */
export function spawnCommand(command: string, args: readonly string[], stdio: 'inherit' | 'ignore' = 'inherit'): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio })
    child.once('error', () => { resolve(127) })
    child.once('close', (code) => { resolve(code ?? 127) })
  })
}

/**
 * The command that hands an address to the computer's browser. Under WSL a set `BROWSER` names the program, as Linux
 * programs read it: the first entry of its colon-separated list runs with the address as its one argument, so a
 * Linux browser or a stand-in that records the address takes it; with `BROWSER` unset or empty, Windows' `start`
 * opens the address in the Windows default browser. `xdg-open` reads `BROWSER` itself on Linux.
 * @param platform - `process.platform`.
 * @param env - the environment, read for WSL and `BROWSER`.
 * @param url - the address.
 * @returns the program and arguments.
 */
export function openerFor(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>, url: string): readonly [string, readonly string[]] {
  if (platform === 'darwin') return ['open', [url]]
  if (platform === 'win32') return ['cmd.exe', ['/c', 'start', '""', url]]
  if ((env['WSL_DISTRO_NAME'] ?? '') !== '') {
    const browser = (env['BROWSER'] ?? '').split(':').find(entry => entry.trim() !== '')
    return browser === undefined ? ['cmd.exe', ['/c', 'start', '""', url]] : [browser.trim(), [url]]
  }
  return ['xdg-open', [url]]
}

/**
 * @param env - the environment.
 * @returns whether the terminal is an SSH session.
 */
function sshSession(env: Readonly<Record<string, string | undefined>>): boolean {
  return [env['SSH_CONNECTION'], env['SSH_TTY']].some(value => value !== undefined && value !== '')
}

/** What the home process answered to `studio.open-token`. */
export type StudioLinkAnswer =
  | { readonly kind: 'link', readonly link: StudioLink }
  /** No home process listens for the profile: no token file, or nothing listens on the update channel. */
  | { readonly kind: 'not-running' }
  /** A home process holds the channel, and its answer did not arrive: it timed out, or the connection failed. */
  | { readonly kind: 'no-answer' }
  /** The home process refused, with its C19 error code and the reason it gave. */
  | { readonly kind: 'refused', readonly code: string, readonly detail?: string }

/** How the studio is opened on this computer; specs replace it. */
export interface StudioOpener {
  /**
   * Ask the profile's home process for a fresh link.
   * @param home - the Delorun home.
   * @param profile - the CLI profile.
   * @param port - a loopback port that forwards to the studio, or `undefined` for the studio's own port.
   * @returns the answer.
   */
  link(home: string, profile: string, port: number | undefined): Promise<StudioLinkAnswer>
  /**
   * Hand a link to the default browser.
   * @param url - the link.
   * @returns whether the browser launcher took it.
   */
  open(url: string): Promise<boolean>
  /**
   * @returns whether a browser can plausibly be shown here: a desktop, and not an SSH session.
   */
  canOpen(): boolean
}

/** Connection errors that mean nothing listens: no token file or socket, or a socket no process holds. */
const NOT_LISTENING = new Set(['ENOENT', 'ECONNREFUSED'])

/**
 * Ask a profile's home process for a fresh studio link, with the start token from the token file.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @param port - a loopback port that forwards to the studio, or `undefined` for the studio's own port.
 * @returns the link; `not-running` when nothing listens; `no-answer` when the request timed out or its connection
 *   failed; or the refusal's code and reason.
 */
export async function requestStudioLink(home: string, profile: string, port?: number): Promise<StudioLinkAnswer> {
  let lines
  try {
    lines = await sendHomeRequest(home, profile, { op: 'studio.open-token', ...port === undefined ? {} : { args: { port } } }, { timeoutMs: HOME_STATUS_TIMEOUT_MS })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code !== undefined && NOT_LISTENING.has(code) ? { kind: 'not-running' } : { kind: 'no-answer' }
  }
  const [line] = lines
  if (line?.ok === true && typeof line.url === 'string' && typeof line.oneTime === 'boolean') return { kind: 'link', link: { url: line.url, oneTime: line.oneTime } }
  return {
    kind: 'refused',
    code: typeof line?.error === 'string' ? line.error : 'NO_ANSWER',
    ...typeof line?.detail === 'string' ? { detail: line.detail } : {},
  }
}

/**
 * The opener of this computer.
 * @param env - the environment `delorun` inherited, read for WSL, `BROWSER` and SSH.
 * @param run - runs the browser launcher; {@link spawnCommand} by default.
 * @param platform - `process.platform` by default.
 * @returns the opener.
 */
export function computerOpener(env: Readonly<Record<string, string | undefined>>, run: typeof spawnCommand = spawnCommand, platform: NodeJS.Platform = process.platform): StudioOpener {
  return {
    link: requestStudioLink,
    async open(url) {
      const [command, args] = openerFor(platform, env, url)
      return (await run(command, args, 'ignore')) === 0
    },
    canOpen: () => !sshSession(env) && canOpenNativePath({ env }),
  }
}

/** What an attempt to open the studio did. */
export type OpenOutcome =
  | { readonly kind: 'opened' }
  /** No browser can be shown here, so no link was asked for. */
  | { readonly kind: 'no-browser' }
  /** The browser launcher did not take the link. */
  | { readonly kind: 'browser-failed' }
  | Exclude<StudioLinkAnswer, { readonly kind: 'link' }>

/**
 * Open the studio in the browser with a fresh link from the home process. No link is asked for when no browser can
 * be shown.
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @param opener - how the link is obtained and opened.
 * @param port - a loopback port that forwards to the studio, or omitted for the studio's own port.
 * @returns what happened.
 */
export async function openStudio(home: string, profile: string, opener: StudioOpener, port?: number): Promise<OpenOutcome> {
  if (!opener.canOpen()) return { kind: 'no-browser' }
  const answer = await opener.link(home, profile, port)
  if (answer.kind !== 'link') return answer
  return (await opener.open(answer.link.url)) ? { kind: 'opened' } : { kind: 'browser-failed' }
}

/**
 * The flag that selects a profile other than the default, for the commands a message names.
 * @param profile - the profile.
 * @returns the flag with a leading space, or the empty string.
 */
export function profileFlag(profile: string): string {
  return profile === 'default' ? '' : ` --profile ${profile}`
}

/**
 * The line that tells the person how to open the studio, which a start prints instead of a link.
 * @param profile - the CLI profile.
 * @returns the line, with its newline.
 */
export function openHint(profile: string): string {
  return `Run delorun open${profileFlag(profile)} to open the studio in your browser.\n`
}

/**
 * One line about an attempt to open the studio; it never contains the link.
 * @param outcome - what happened.
 * @param profile - the CLI profile.
 * @returns the line, with its newline.
 */
export function describeOpening(outcome: OpenOutcome, profile: string): string {
  const flag = profileFlag(profile)
  switch (outcome.kind) {
    case 'opened':
      return 'Opened the studio in your browser.\n'
    case 'no-browser':
      return `There is no browser to open here. Run delorun open --print${flag} for a link that signs in once, within one minute.\n`
    case 'browser-failed':
      return `No browser took the studio link. Run delorun open --print${flag} for a link that signs in once, within one minute.\n`
    case 'not-running':
      return `${notRunningText(profile)}\n`
    case 'no-answer':
      return `The home process for the profile ${profile} is listening but did not answer in time; see delorun status${flag} and delorun logs${flag}.\n`
    case 'refused':
      return `The home process for the profile ${profile} did not give a studio link (${outcome.code}${outcome.detail === undefined ? '' : `: ${cliRedactor().text(outcome.detail)}`}); see delorun status${flag}.\n`
    default: {
      const unknown: never = outcome
      throw new Error(`unknown opening outcome ${JSON.stringify(unknown)}`)
    }
  }
}
