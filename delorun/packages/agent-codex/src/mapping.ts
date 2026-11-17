/**
 * Pure mappings from Codex's wire values to the driver contract: tool items to tool calls and results, token usage,
 * turn errors to the closed failure set, and rate limits and models to an account observation.
 * @module @delorun/agent-codex/mapping
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { isAgentSignInFailure } from '@deepseek-ai/dsh-subagent'
import type { AccountObservation, LimitWindow, OfferedModel, ProgramFailure } from '@delorun/external-agents/contract'
import type { ClientResult, RateLimitSnapshot, TokenUsageBreakdown, ToolItem, TurnError, WireJson } from './protocol.ts'

/** A program tool call as the seat records it. */
export interface MappedCall { readonly name: string; readonly input: string }
/** A program tool result as the seat records it. */
export interface MappedResult { readonly output: string; readonly isError: boolean }

/**
 * The tool name and input for one of Codex's tool items. MCP tools take Claude Code's `mcp__<server>__<tool>` form,
 * so the two drivers name them alike.
 * @param item - the item from `item/started`.
 * @returns the name and the input as JSON text.
 */
export function toolCall(item: ToolItem): MappedCall {
  switch (item.type) {
    case 'commandExecution':
      return { name: 'shell', input: JSON.stringify({ command: item.command, cwd: item.cwd }) }
    case 'fileChange':
      return { name: 'apply_patch', input: JSON.stringify({ changes: item.changes.map(({ path, diff }) => ({ path, diff })) }) }
    case 'mcpToolCall':
      return { name: `mcp__${item.server}__${item.tool}`, input: JSON.stringify(item.arguments) }
    case 'webSearch':
      return { name: 'web_search', input: JSON.stringify({ query: item.query }) }
  }
}

/** The text of an MCP result: its text blocks joined, or the blocks as JSON when none is text. */
function mcpText(content: readonly WireJson[]): string {
  const texts = content.flatMap(block => typeof block === 'object' && block !== null && !Array.isArray(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
  return texts.length > 0 ? texts.join('\n') : JSON.stringify(content)
}

/**
 * The result for one of Codex's tool items when it completed.
 * @param item - the item from `item/completed`.
 * @returns the output text and whether it failed.
 */
export function toolResult(item: ToolItem): MappedResult {
  switch (item.type) {
    case 'commandExecution':
      if (item.status === 'declined') return { output: 'The command was not run: it was declined.', isError: true }
      return { output: item.aggregatedOutput ?? '', isError: item.status !== 'completed' || (item.exitCode ?? 0) !== 0 }
    case 'fileChange':
      if (item.status === 'declined') return { output: 'The change was not made: it was declined.', isError: true }
      return { output: item.changes.map(change => change.path).join('\n'), isError: item.status !== 'completed' }
    case 'mcpToolCall':
      if (item.error !== null && item.error !== undefined) return { output: item.error.message, isError: true }
      return { output: mcpText(item.result?.content ?? []), isError: item.status !== 'completed' }
    case 'webSearch':
      return { output: `Searched the web for: ${item.query}`, isError: false }
  }
}

/**
 * The harness's disjoint token counts for one Codex model request.
 * @param last - `thread/tokenUsage/updated`'s `last` breakdown.
 * @returns the usage, with cached input counted apart from fresh input.
 */
export function usageOf(last: TokenUsageBreakdown): TokenUsage {
  const cacheWrite = last.cacheWriteInputTokens ?? 0
  return {
    inputTokens: Math.max(0, last.inputTokens - last.cachedInputTokens - cacheWrite),
    outputTokens: last.outputTokens,
    totalTokens: last.totalTokens,
    cacheReadTokens: last.cachedInputTokens,
    ...cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {},
    reasoningTokens: last.reasoningOutputTokens,
  }
}

const sum = (a: number | undefined, b: number | undefined): number | undefined => a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)

/**
 * Two usages added field by field.
 * @param a - the earlier usage, if any.
 * @param b - the later usage.
 * @returns their sum.
 */
export function addUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  if (a === undefined) return b
  const total = sum(a.totalTokens, b.totalTokens)
  const cacheRead = sum(a.cacheReadTokens, b.cacheReadTokens)
  const cacheWrite = sum(a.cacheWriteTokens, b.cacheWriteTokens)
  const reasoning = sum(a.reasoningTokens, b.reasoningTokens)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...total === undefined ? {} : { totalTokens: total },
    ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    ...cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
}

/** Codex's error names that mean the plan's usage limit is reached. */
const LIMIT_ERRORS: ReadonlySet<string> = new Set(['usageLimitExceeded', 'rateLimitExceeded'])

/** Whether a one-key error object carries HTTP status 401. */
function isUnauthorizedStatus(info: Readonly<Record<string, WireJson>>): boolean {
  return Object.values(info).some(detail => typeof detail === 'object' && detail !== null && !Array.isArray(detail) && detail.httpStatusCode === 401)
}

/**
 * When the reached limit lifts: the latest reset among windows at 100 %, in epoch milliseconds.
 * @param snapshot - the last rate-limit snapshot seen, if any.
 * @returns the time, or undefined when no reached window names one.
 */
export function limitResetsAt(snapshot: RateLimitSnapshot | undefined): number | undefined {
  const resets = [snapshot?.primary, snapshot?.secondary]
    .flatMap(window => window !== null && window !== undefined && window.usedPercent >= 100 && typeof window.resetsAt === 'number' ? [window.resetsAt * 1000] : [])
  return resets.length > 0 ? Math.max(...resets) : undefined
}

/**
 * The closed failure for a failed turn.
 * @param error - the turn's error, or the last `error` notification when the turn carried none.
 * @param snapshot - the last rate-limit snapshot seen, for a limit's reset time.
 * @returns `signed-out`, `limit`, or `program` with Codex's message for the person's view.
 */
export function turnFailure(error: TurnError | undefined, snapshot: RateLimitSnapshot | undefined): ProgramFailure {
  if (error === undefined) return { category: 'program', detail: 'Codex ended the turn without saying why.' }
  const info = error.codexErrorInfo
  if (info === 'unauthorized' || (typeof info === 'object' && info !== null && isUnauthorizedStatus(info)) || isAgentSignInFailure(error.message)) {
    return { category: 'signed-out' }
  }
  if (typeof info === 'string' && LIMIT_ERRORS.has(info)) {
    const resetsAt = limitResetsAt(snapshot)
    return resetsAt === undefined ? { category: 'limit' } : { category: 'limit', resetsAt }
  }
  return { category: 'program', detail: error.message }
}

/** Claude Code's window names for the two durations both programs share. */
const WINDOW_KINDS: Readonly<Record<number, string>> = { 300: 'five_hour', 10_080: 'seven_day' }

/**
 * The limit windows in a rate-limit snapshot, primary first.
 * @param snapshot - the snapshot.
 * @returns one window per present limit; `reached` at 100 % used, otherwise `allowed`.
 */
export function windowsOf(snapshot: RateLimitSnapshot): LimitWindow[] {
  return [snapshot.primary, snapshot.secondary].flatMap((window) => {
    if (window === null || window === undefined) return []
    const minutes = window.windowDurationMins
    const kind = typeof minutes === 'number' ? WINDOW_KINDS[minutes] ?? `window_${minutes}m` : 'window'
    return [{
      kind,
      usedPercent: window.usedPercent,
      ...typeof window.resetsAt === 'number' ? { resetsAt: window.resetsAt * 1000 } : {},
      status: window.usedPercent >= 100 ? 'reached' : 'allowed',
    }]
  })
}

/**
 * The models a person may pick: `model/list` entries that are not hidden.
 * @param data - every page's entries.
 * @returns each offered model's configurable name, display name and whether it is the plan's default.
 */
export function offeredModels(data: ClientResult<'model/list'>['data']): OfferedModel[] {
  return data.filter(entry => !entry.hidden).map(entry => ({ id: entry.model, displayName: entry.displayName, isDefault: entry.isDefault }))
}

/** The parts of an account observation Codex reports. */
export interface ObservationParts {
  readonly account?: ClientResult<'account/read'>
  readonly snapshot?: RateLimitSnapshot
  readonly offered?: readonly OfferedModel[]
  readonly source: AccountObservation['source']
}

/**
 * An account observation with no personal field: sign-in state, plan, windows and offered models.
 * @param parts - what Codex reported.
 * @returns the observation for the `codex` provider.
 */
export function observationOf(parts: ObservationParts): AccountObservation {
  const { account, snapshot } = parts
  const signedIn = account === undefined
    ? (parts.source === 'run' ? 'yes' : 'unknown')
    : account.account !== null ? 'yes' : account.requiresOpenaiAuth ? 'no' : 'unknown'
  const plan = account?.account?.type === 'chatgpt' ? account.account.planType : snapshot?.planType ?? undefined
  return {
    provider: 'codex',
    signedIn,
    ...plan === undefined || plan === null ? {} : { plan },
    windows: snapshot === undefined ? [] : windowsOf(snapshot),
    ...parts.offered === undefined ? {} : { offeredModels: parts.offered },
    source: parts.source,
  }
}
