/**
 * The fixed sentences the gate's refusals carry to the model and the person. Free of Node and Cordis, so the consent
 * and the client import them.
 * @module @delorun/external-agents/copy
 */
import type { ExternalAgentName } from './contract.ts'

/** The name a person knows each agent by. */
const AGENT_TITLES: Readonly<Record<ExternalAgentName, string>> = { 'claude-code': 'Claude Code', 'codex': 'Codex' }

/** The plan each agent's limits belong to. */
const PLAN_NAMES: Readonly<Record<ExternalAgentName, string>> = { 'claude-code': 'Claude', 'codex': 'ChatGPT' }

/** Plain names of the limit windows the programs report, by the program's own name. */
const WINDOW_NAMES: Readonly<Record<string, string>> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  primary: '5-hour',
  secondary: 'weekly',
}

/**
 * The name a person knows an agent by.
 * @param provider - the agent.
 * @returns its product name.
 */
export function agentTitle(provider: ExternalAgentName): string {
  return AGENT_TITLES[provider]
}

/**
 * The refusal while the consent is missing, failed, not running, or cannot review a live agent.
 * @param provider - the agent.
 * @returns the sentence.
 */
export function consentMissingRefusal(provider: ExternalAgentName): string {
  const name = agentTitle(provider)
  return `${name} was not started: Delorun's consent for external agents is not running, so no live agent starts. Tell the person; restarting Delorun usually fixes it.`
}

/**
 * The refusal while the consent row is disabled in the profile.
 * @param provider - the agent.
 * @returns the sentence.
 */
export function consentRowDisabledRefusal(provider: ExternalAgentName): string {
  const name = agentTitle(provider)
  return `${name} was not started: Delorun's consent for external agents is disabled in this profile, so no live agent starts. Tell the person.`
}

/**
 * The refusal of a seat whose chat is not running under a chat a person sees.
 * @param provider - the agent.
 * @returns the sentence.
 */
export function noRootRefusal(provider: ExternalAgentName): string {
  return `${agentTitle(provider)} was not started: its chat is not open under a chat the person sees.`
}

/**
 * How long until a time, in hours and minutes.
 * @param ms - the time left, in milliseconds.
 * @returns words such as `2 h 5 min` or `under a minute`.
 */
function remaining(ms: number): string {
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 1) return 'under a minute'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} min`
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/**
 * The refusal of a start while a plan limit is reached (T12). The time is the Host's local time; a reset more than a
 * day away also names the day.
 * @param facts - the agent, the window, the reset time and now, in milliseconds since the epoch, and the time zone.
 * @returns the sentence the model reads.
 */
export function limitRefusal(facts: { readonly provider: ExternalAgentName, readonly window: string, readonly resetsAt: number, readonly now: number, readonly timeZone?: string }): string {
  const name = agentTitle(facts.provider)
  const window = WINDOW_NAMES[facts.window] ?? `"${facts.window}"`
  const zone = facts.timeZone === undefined ? {} : { timeZone: facts.timeZone }
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', ...zone }).format(facts.resetsAt)
  const day = facts.resetsAt - facts.now > 86_400_000
    ? `${new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', ...zone }).format(facts.resetsAt)} at `
    : ''
  return `${name} was not started: your ${PLAN_NAMES[facts.provider]} plan's ${window} limit is reached until ${day}${time} (in ${remaining(facts.resetsAt - facts.now)}). `
    + `Do not hand work to ${name} before then; do the task yourself or tell the person.`
}
