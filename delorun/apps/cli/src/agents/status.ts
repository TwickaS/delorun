/**
 * `delorun agents status [claude-code | codex] [--refresh] [--json]`: whether each external agent is signed in, its
 * plan, and each plan-limit window with its used share, its reset time and when it was seen ("as of").
 *
 * While Delorun runs, the command asks the running Host over the update channel (`agents.accounts`, contract C19);
 * otherwise it reads the accounts file the Host keeps. `--refresh` asks the running Host to check now
 * (`agents.refresh`), which starts the person's own program with no task and honours the Host's interval between
 * checks; the CLI never starts a program itself, so without a running Host `--refresh` says to start Delorun.
 *
 * @module @delorun/cli/agents/status
 */
import { accountsFilePath, parseAccountsAnswer, parseRefreshAnswer, readAccountsFile, windowStanding, windowTitle, type AccountsAnswer, type AccountView, type RefreshOutcome, type StoredWindow } from '@delorun/external-agents/accounts'
import type { ResponseLine, UnsignedRequest } from '@delorun/home-process'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import type { CommandContext } from '../command.ts'
import { notRunningText } from '../messages.ts'
import { readableTime, type TimeOptions } from '../output.ts'
import { AGENT_PACKS, EXTERNAL_AGENTS } from '@delorun/external-agents/locate'
import type { ExternalAgentName } from '@delorun/external-agents/contract'

/** What the status command runs against. */
export interface StatusDependencies {
  /**
   * Whether the profile's Delorun runs.
   * @param home - the Delorun home.
   * @param profile - the profile.
   * @returns whether its home process holds the lock.
   */
  readonly running: (home: string, profile: string) => boolean
  /**
   * Send one request over the profile's update channel.
   * @param home - the Delorun home.
   * @param profile - the profile.
   * @param request - the request.
   * @returns the response lines.
   */
  readonly send: (home: string, profile: string, request: UnsignedRequest) => Promise<readonly ResponseLine[]>
  /**
   * Whether an agent's pack is added to the profile, for figures read from the file.
   * @param agent - the agent.
   * @returns whether its program is found.
   */
  readonly installed: (agent: ExternalAgentName) => boolean
  /**
   * The current time.
   * @returns milliseconds since the epoch.
   */
  readonly now: () => number
  /** How times print. */
  readonly time?: TimeOptions
}

/** One invocation's choices. */
export interface StatusRequest {
  readonly home: string
  readonly profile: string
  /** The agent named, or every agent. */
  readonly agent?: ExternalAgentName
  readonly refresh: boolean
  readonly json: boolean
}

/** What `--json` prints. */
export interface StatusJson {
  /** Where the figures came from: the running Host, or the accounts file. */
  readonly source: 'host' | 'file'
  /** The time the figures were read at, in milliseconds since the epoch. */
  readonly now: number
  /** The agents asked about, in order. */
  readonly accounts: readonly AccountView[]
  /** What each `--refresh` did, by agent. */
  readonly refreshed?: Readonly<Partial<Record<ExternalAgentName, RefreshOutcome>>>
}

/**
 * Run `delorun agents status`.
 * @param request - the invocation's choices.
 * @param context - the output.
 * @param dependencies - what it runs against.
 * @returns {@link EXIT.ok}, or {@link EXIT.failed} when a check failed or was refused.
 * @throws {CliError} {@link EXIT.notRunning} for `--refresh` while Delorun does not run, and {@link EXIT.failed} for a
 *   refusal or an answer this command cannot read.
 */
export async function agentsStatus(request: StatusRequest, context: CommandContext, dependencies: StatusDependencies): Promise<ExitCode> {
  const agents = request.agent === undefined ? EXTERNAL_AGENTS : [request.agent]
  const running = dependencies.running(request.home, request.profile)
  if (request.refresh && !running) {
    throw new CliError(EXIT.notRunning, `delorun agents status --refresh: a check runs in Delorun. ${notRunningText(request.profile)}`)
  }
  const refreshed: Partial<Record<ExternalAgentName, RefreshOutcome>> = {}
  if (request.refresh) {
    for (const agent of agents) refreshed[agent] = await refreshOne(request, agent, dependencies)
  }
  const answer = running ? await fromHost(request, dependencies) : await fromFile(request.home, dependencies)
  const accounts = answer.accounts.filter(account => agents.includes(account.provider))
  if (request.json) {
    const printed: StatusJson = { source: running ? 'host' : 'file', now: answer.now, accounts, ...request.refresh ? { refreshed } : {} }
    context.stdout(`${JSON.stringify(printed, null, 2)}\n`)
  } else {
    const lines: string[] = []
    for (const account of accounts) {
      const outcome = refreshed[account.provider]
      if (outcome !== undefined) lines.push(refreshLine(account.provider, outcome, dependencies.time))
      lines.push(...accountLines(account, answer.now, dependencies.time))
    }
    if (!running) lines.push('', `These are the figures Delorun last saw. ${notRunningText(request.profile)}`)
    context.stdout(`${lines.join('\n')}\n`)
  }
  return Object.values(refreshed).some(outcome => outcome.kind === 'failed' || outcome.kind === 'refused') ? EXIT.failed : EXIT.ok
}

/**
 * Ask the running Host to check one agent now.
 * @param request - the invocation.
 * @param agent - the agent.
 * @param dependencies - the channel.
 * @returns what the check did.
 * @throws {CliError} {@link EXIT.failed} for a refusal or an answer this command cannot read.
 */
async function refreshOne(request: StatusRequest, agent: ExternalAgentName, dependencies: StatusDependencies): Promise<RefreshOutcome> {
  const line = final(await dependencies.send(request.home, request.profile, { op: 'agents.refresh', args: { provider: agent, reason: 'check-now' } }))
  if (line.ok !== true) throw new CliError(EXIT.failed, `delorun agents status: Delorun refused the check: ${refusal(line)}`)
  const answer = parseRefreshAnswer(line)
  if (answer === undefined) throw new CliError(EXIT.failed, 'delorun agents status: Delorun answered the check with figures this command cannot read')
  return answer.outcome
}

/**
 * The figures the running Host holds.
 * @param request - the invocation.
 * @param dependencies - the channel.
 * @returns the answer.
 * @throws {CliError} {@link EXIT.failed} for a refusal or an answer this command cannot read.
 */
async function fromHost(request: StatusRequest, dependencies: StatusDependencies): Promise<AccountsAnswer> {
  const line = final(await dependencies.send(request.home, request.profile, { op: 'agents.accounts' }))
  if (line.ok !== true) {
    // A Host without external agents still has the file its earlier runs wrote.
    if (line.error === 'AGENTS_UNAVAILABLE') return fromFile(request.home, dependencies)
    throw new CliError(EXIT.failed, `delorun agents status: Delorun refused: ${refusal(line)}`)
  }
  const answer = parseAccountsAnswer(line)
  if (answer === undefined) throw new CliError(EXIT.failed, 'delorun agents status: Delorun answered with figures this command cannot read')
  return answer
}

/**
 * The figures the accounts file holds; a file that cannot be read reads as no figures.
 * @param home - the Delorun home.
 * @param dependencies - the pack lookup and the clock.
 * @returns the answer.
 */
async function fromFile(home: string, dependencies: StatusDependencies): Promise<AccountsAnswer> {
  const read = await readAccountsFile(accountsFilePath(home))
  const stored = read.kind === 'readable' ? read.file.accounts : {}
  return {
    now: dependencies.now(),
    accounts: EXTERNAL_AGENTS.map(provider => ({ provider, installed: dependencies.installed(provider), ...stored[provider] ?? { signedIn: 'unknown' as const, windows: [] } })),
  }
}

/**
 * A plan's name as a person reads it.
 * @param plan - the plan as the program spells it, such as `max` or `chatgpt_plus`.
 * @returns the name, such as `Max` or `Chatgpt plus`.
 */
export function planTitle(plan: string): string {
  const words = plan.replaceAll(/[_-]+/gu, ' ').trim()
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

/**
 * The lines that describe one agent's figures.
 * @param account - the agent's figures.
 * @param now - the time they were read at.
 * @param time - how times print.
 * @returns the lines.
 */
export function accountLines(account: AccountView, now: number, time: TimeOptions = {}): string[] {
  const title = AGENT_PACKS[account.provider].title
  const at = (value: number): string => readableTime(value, time)
  const plan = account.plan === undefined ? '' : ` · ${planTitle(account.plan)} plan`
  const head = account.signedIn === 'yes' ? `${title}: signed in${plan}`
    : account.signedIn === 'no' ? `${title}: signed out. Sign in with: delorun agents login ${account.provider}`
      : `${title}: sign-in not known yet${plan}`
  const lines = [account.installed ? head : `${title}: not added. Add it in the Agents step of setup or in Plugins.`]
  for (const window of account.windows) lines.push(`  ${windowLine(window, now, time)}`)
  if (account.installed && account.windows.length === 0) lines.push(`  No limit figures yet. Check now: delorun agents status ${account.provider} --refresh`)
  if (account.checkedAt !== undefined) lines.push(`  Last checked ${at(account.checkedAt)}.`)
  if (account.checkFailedAt !== undefined && account.checkFailedAt > (account.checkedAt ?? 0)) lines.push(`  The last check, ${at(account.checkFailedAt)}, did not answer; the figures are as last seen.`)
  return lines
}

/**
 * One limit window as a person reads it: its name, its used share, its reset time and when it was seen.
 * @param window - the window.
 * @param now - the time the figures were read at.
 * @param time - how times print.
 * @returns the line.
 */
export function windowLine(window: StoredWindow, now: number, time: TimeOptions = {}): string {
  const at = (value: number): string => readableTime(value, time)
  const used = window.usedPercent === undefined ? '' : `${String(Math.round(window.usedPercent))}% used`
  const asOf = `as of ${at(window.seenAt)}`
  if (window.resetsAt !== undefined && windowStanding(window, now) === 'reset') {
    return `${windowTitle(window.kind)}: reset at ${at(window.resetsAt)}, not checked since (${[used, asOf].filter(part => part !== '').join(', ')})`
  }
  const state = window.status === 'reached' ? 'limit reached' : window.status === 'near' ? 'near the limit' : ''
  const resets = window.resetsAt === undefined ? '' : `${window.status === 'reached' ? 'until' : 'resets'} ${at(window.resetsAt)}`
  const parts = [state === '' ? used : `${state}${used === '' ? '' : ` (${used})`}`, resets].filter(part => part !== '')
  return `${windowTitle(window.kind)}: ${parts.length === 0 ? 'no figures' : parts.join(', ')} (${asOf})`
}

/**
 * What a refresh did, as one line.
 * @param agent - the agent.
 * @param outcome - what the refresh did.
 * @param time - how times print.
 * @returns the line.
 */
export function refreshLine(agent: ExternalAgentName, outcome: RefreshOutcome, time: TimeOptions = {}): string {
  const title = AGENT_PACKS[agent].title
  switch (outcome.kind) {
    case 'checked': return `Checked ${title} now.`
    case 'throttled': return `${title} was checked a short while ago; the next check can run at ${readableTime(outcome.nextAt, time)}.`
    case 'not-installed': return `${title} is not added, so nothing was checked.`
    case 'failed': return `The ${title} check did not answer (${outcome.problem}).`
    case 'refused': return `The ${title} check did not start: ${outcome.problem}`
    case 'turned-off': return `${title} was not checked: this profile's settings do not start a check for this.`
  }
}

/**
 * A refused answer's code and detail.
 * @param line - the final line.
 * @returns the code, with the detail when there is one.
 */
function refusal(line: ResponseLine): string {
  return `${String(line.error)}${typeof line.detail === 'string' ? ` (${line.detail})` : ''}`
}

/**
 * The final response line.
 * @param lines - the lines.
 * @returns the last one, or a failure when there is none.
 */
function final(lines: readonly ResponseLine[]): ResponseLine {
  return lines.at(-1) ?? { ok: false, error: 'NO_ANSWER' }
}
