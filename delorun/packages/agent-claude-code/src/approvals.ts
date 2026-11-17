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
import type { JsonValue, ProgramApprovalAnswer, ProgramApprovalRequest, ProgramRunRule } from './pending-contract.ts'

/** What the program's model reads when the person rejects a call. */
export const REJECTED_MESSAGE = 'The person rejected this tool call.'
/** What the program's model reads when the person stops the turn while the question is open. */
export const CANCELLED_MESSAGE = 'The person stopped this turn.'

/**
 * The allow rules among the program's suggestions.
 * @param suggestions - the program's suggestions for one question.
 * @returns the rules of every `addRules` allow entry, in order; nothing else.
 */
export function suggestedAllowRules(suggestions: readonly PermissionUpdate[] | undefined): PermissionRuleValue[] {
  return (suggestions ?? []).flatMap(suggestion =>
    suggestion.type === 'addRules' && suggestion.behavior === 'allow' ? suggestion.rules.map(rule => ({ ...rule })) : [])
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
 * The rules a run rule holds. A rule another driver made, or data that is not this driver's, holds none.
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
    return [typeof content === 'string' ? { toolName: entry.toolName, ruleContent: content } : { toolName: entry.toolName }]
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
 * The plain description of a question for the person: the program's own sentence when it gives one.
 * @param toolName - the program's tool name.
 * @param input - the call's input.
 * @param options - the question's details.
 * @param options.title - the program's full question sentence.
 * @param options.description - the program's subtitle.
 * @param options.displayName - the program's short name for the action.
 * @returns the reason.
 */
export function questionReason(toolName: string, input: Record<string, unknown>, options: { title?: string; description?: string; displayName?: string }): string {
  if (options.title !== undefined && options.title.length > 0) return options.title
  if (options.description !== undefined && options.description.length > 0) return options.description
  const detail = JSON.stringify(input)
  return `${options.displayName ?? toolName}: ${detail.length > 300 ? `${detail.slice(0, 300)}…` : detail}`
}

/**
 * The SDK's `canUseTool` over the seat's question handler.
 * @param ask - the seat's handler.
 * @param beforeAsk - called before each question goes to the seat; the session ends the open program message there.
 * @returns the SDK callback.
 */
export function canUseTool(ask: (request: ProgramApprovalRequest) => Promise<ProgramApprovalAnswer>, beforeAsk: () => void): CanUseTool {
  return async (toolName, input, options) => {
    beforeAsk()
    const rules = suggestedAllowRules(options.suggestions)
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
    return permissionResult(answer, input, rules)
  }
}
