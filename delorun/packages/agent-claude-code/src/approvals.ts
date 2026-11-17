/**
 * Claude Code's permission questions as the seat's approval requests, and "Allow for this run" as session rules.
 *
 * "Allow for this run" covers exactly the allow rules Claude Code suggests for the one call: each `addRules` allow
 * entry, re-scoped to `session`. A suggested mode change (`setMode`) or folder grant (`addDirectories`) is never
 * forwarded, since either widens the allowance far past the one command. When the program suggests no allow rule, the
 * question offers no run rule.
 * @module @delorun/agent-claude-code/approvals
 */
import type { CanUseTool, PermissionResult, PermissionRuleValue, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { JsonValue, ProgramApprovalAnswer, ProgramApprovalRequest, ProgramRunRule } from '@delorun/external-agents/contract'

/** What the program's model reads when the person rejects a call. */
export const REJECTED_MESSAGE = 'The person rejected this tool call.'
/** What the program's model reads when the person stops the turn while the question is open. */
export const CANCELLED_MESSAGE = 'The person stopped this turn.'

/**
 * Whether a rule allows exactly one command and nothing more: content present, without Claude Code's wildcard `*`
 * (which also excludes the `:*` prefix form), and on one line.
 * @param rule - a rule.
 * @returns whether it is exact.
 */
function exactRule(rule: PermissionRuleValue): boolean {
  return rule.ruleContent !== undefined && rule.ruleContent.length > 0 && !/[*\n\r]/.test(rule.ruleContent)
}

/**
 * Characters that keep a rule from being built from a Bash call: parentheses, a redirect and a pipe, for which Claude
 * Code's matching of a repeat was not shown. `*` and line breaks are excluded from every rule.
 */
const BUILT_RULE_EXCLUDED = /[()<>|]/

/**
 * The rule "Allow for this run" may add for one question, which covers the exact command asked about and nothing else.
 * Claude Code's single suggested `addRules` allow entry is taken when it is for the tool that asked and its content
 * equals that command. Otherwise, for `Bash` only, the rule is built from the call itself: `Bash(<exact command>)`,
 * unless the command holds a parenthesis, a redirect (`<`, `>`) or a pipe (`|`). A command holding `*` or a line
 * break gets no rule, and neither does any other tool whose suggestion is not exact.
 * Mode changes (`setMode`) and folder grants (`addDirectories`) are never taken.
 * @param toolName - the tool that asked.
 * @param input - the call's input.
 * @param suggestions - Claude Code's suggested permission updates.
 * @returns the one exact rule, or none.
 */
export function exactRunRules(toolName: string, input: Record<string, unknown>, suggestions: readonly PermissionUpdate[] | undefined): PermissionRuleValue[] {
  const command = input.command
  if (typeof command !== 'string') return []
  const exact = { toolName, ruleContent: command }
  if (!exactRule(exact)) return []
  const rules = (suggestions ?? []).flatMap(suggestion =>
    suggestion.type === 'addRules' && suggestion.behavior === 'allow' ? suggestion.rules : [])
  const [rule] = rules
  const suggestedExact = rules.length === 1 && rule !== undefined && rule.toolName === toolName && rule.ruleContent === command
  return suggestedExact || (toolName === 'Bash' && !BUILT_RULE_EXCLUDED.test(command)) ? [exact] : []
}

/**
 * One rule in Claude Code's permission-rule syntax, `Tool` or `Tool(content)`, with backslashes and parentheses in the
 * content escaped as Claude Code escapes them.
 * @param rule - the rule.
 * @returns the rule text.
 */
export function ruleText(rule: PermissionRuleValue): string {
  if (rule.ruleContent === undefined) return rule.toolName
  const content = rule.ruleContent.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  return `${rule.toolName}(${content})`
}

/**
 * The run rule a question offers.
 * @param rules - the question's suggested allow rules.
 * @returns the run rule, or undefined when there is none.
 */
export function runRuleFor(rules: readonly PermissionRuleValue[]): ProgramRunRule | undefined {
  if (rules.length === 0) return undefined
  const data: JsonValue = {
    rules: rules.map(rule => rule.ruleContent === undefined ? { toolName: rule.toolName } : { toolName: rule.toolName, ruleContent: rule.ruleContent }),
  }
  return { provider: 'claude-code', summary: rules.map(ruleText).join(', '), data }
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The rules a run rule holds. A rule another driver made, data that is not this driver's, and a rule that is not exact
 * hold none.
 * @param rule - a run rule from the seat.
 * @returns its rules.
 */
export function rulesOf(rule: ProgramRunRule): PermissionRuleValue[] {
  if (rule.provider !== 'claude-code' || !isRecord(rule.data)) return []
  const rules = rule.data.rules
  if (!Array.isArray(rules)) return []
  return rules.flatMap((entry: JsonValue): PermissionRuleValue[] => {
    if (!isRecord(entry) || typeof entry.toolName !== 'string') return []
    const content = entry.ruleContent
    if (typeof content !== 'string') return []
    const value = { toolName: entry.toolName, ruleContent: content }
    return exactRule(value) ? [value] : []
  })
}

/**
 * The `allowedTools` entries that re-apply run rules when a program process starts. They hold for that process only,
 * as the `session` rules they replace did.
 * @param runRules - the run rules the seat keeps for this child.
 * @returns the rule texts, without repeats.
 */
export function allowedToolsFor(runRules: readonly ProgramRunRule[]): string[] {
  return [...new Set(runRules.flatMap(rulesOf).map(ruleText))]
}

/**
 * The program's answer for the person's answer.
 * @param answer - the person's answer.
 * @param input - the call's input, passed back unchanged on allow.
 * @param rules - the question's suggested allow rules.
 * @returns the permission result.
 */
export function permissionResult(answer: ProgramApprovalAnswer, input: Record<string, unknown>, rules: readonly PermissionRuleValue[]): PermissionResult {
  switch (answer) {
    case 'allow-once':
      return { behavior: 'allow', updatedInput: input }
    case 'allow-run':
      return rules.length === 0
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'addRules', rules: [...rules], behavior: 'allow', destination: 'session' }] }
    case 'reject':
      return { behavior: 'deny', message: REJECTED_MESSAGE }
    case 'cancel':
      return { behavior: 'deny', message: CANCELLED_MESSAGE, interrupt: true }
    default: {
      const unknown: never = answer
      throw new Error(`agent-claude-code: unknown approval answer ${String(unknown)}`)
    }
  }
}

/**
 * The plain description of a question for the person: Claude Code's own question sentence when it gives one,
 * otherwise the tool and the exact call. The call's own `description` field is the program model's words, not a
 * statement of what runs, so it is never the reason.
 * @param toolName - the program's tool name.
 * @param input - the call's input.
 * @param options - the question's details.
 * @param options.title - Claude Code's full question sentence.
 * @param options.displayName - Claude Code's short name for the action.
 * @returns the reason.
 */
export function questionReason(toolName: string, input: Record<string, unknown>, options: { title?: string; displayName?: string }): string {
  if (options.title !== undefined && options.title.length > 0) return options.title
  const detail = typeof input.command === 'string' ? input.command : JSON.stringify(input)
  return `${options.displayName ?? toolName}: ${detail.length > 300 ? `${detail.slice(0, 300)}…` : detail}`
}

/** What the session does around a question. */
export interface QuestionHooks {
  /** Called before the question goes to the seat; the session ends the open program message there. */
  beforeAsk(): void
  /** Called when the answer stops the turn, so the session reports the turn as interrupted. */
  onCancel(): void
}

/**
 * The SDK's `canUseTool` over the seat's question handler. A question about one of the session's own harness tools,
 * matched by its full name on the session's own server, is allowed here: the harness tool's own approval applies when
 * it runs. Every other question goes to the seat.
 * @param ask - the seat's handler.
 * @param hooks - the session's hooks around each question.
 * @param ownTools - the full names of the harness tools this session offered, `mcp__<server>__<tool>`.
 * @returns the SDK callback.
 */
export function canUseTool(ask: (request: ProgramApprovalRequest) => Promise<ProgramApprovalAnswer>, hooks: QuestionHooks, ownTools: ReadonlySet<string>): CanUseTool {
  return async (toolName, input, options) => {
    if (ownTools.has(toolName)) return { behavior: 'allow', updatedInput: input }
    hooks.beforeAsk()
    const rules = exactRunRules(toolName, input, options.suggestions)
    const runRule = runRuleFor(rules)
    let answer: ProgramApprovalAnswer
    try {
      answer = await ask({
        callId: options.toolUseID,
        toolName,
        reason: questionReason(toolName, input, options),
        ...runRule === undefined ? {} : { runRule },
        signal: options.signal,
      })
    } catch (_failed) {
      // The seat could not answer, so no one decided: the call does not run and the turn stops.
      answer = 'cancel'
    }
    if (answer === 'cancel') hooks.onCancel()
    return permissionResult(answer, input, rules)
  }
}
