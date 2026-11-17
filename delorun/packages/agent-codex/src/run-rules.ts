/**
 * "Allow for this run" for Codex (D4). A run rule exists only for a plain command question, and a later question is
 * answered by a rule only when it is the same thread, the same argv array element by element, the same working folder
 * and environment, and carries no escalation, network or policy-amendment field. A file change never gets a rule. The
 * driver answers a covered question with a one-time `accept` itself, so it never sends Codex's `acceptForSession` or an
 * exec-policy amendment, and Codex's own scoping of either never widens what the person allowed.
 * @module @delorun/agent-codex/run-rules
 */
import type { ProgramRunRule } from '@delorun/external-agents/contract'
import { z } from 'zod'

/** The fields of a command question a run rule depends on. */
export interface CommandQuestion {
  /** The thread that asks. */
  readonly threadId: string
  /** `command` for a command; `writeStdin` for input to a running terminal. */
  readonly kind?: 'command' | 'writeStdin' | undefined
  /** Set for a sub-command callback of a running command. */
  readonly approvalId?: string | null | undefined
  /** Codex's explanation, which it gives for an escalation outside the sandbox. */
  readonly reason?: string | null | undefined
  /** The command as Codex reports it: its argv, shell-quoted. */
  readonly command?: string | null | undefined
  /** The working folder. */
  readonly cwd?: string | null | undefined
  /** Where the command runs. */
  readonly environmentId?: string | null | undefined
  /** Present on a managed-network question. */
  readonly networkApprovalContext?: unknown
  /** Network allow or deny rules Codex proposes. */
  readonly proposedNetworkPolicyAmendments?: readonly unknown[] | null | undefined
}

/** A command rule's `data`, as the driver writes it and reads it back from the gate. */
const CommandRuleData = z.strictObject({
  kind: z.literal('command'),
  threadId: z.string().min(1),
  argv: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  environmentId: z.string().nullable(),
})
type CommandRuleData = z.infer<typeof CommandRuleData>

/**
 * Split a command the way a POSIX shell splits words: single quotes are literal, double quotes keep `\` before
 * `$`, `` ` ``, `"`, `\` and a newline, and a `\` outside quotes takes the next character.
 * @param command - the shell-quoted command.
 * @returns the words, or undefined when a quote is not closed or a `\` ends the text.
 */
export function shellWords(command: string): string[] | undefined {
  const words: string[] = []
  let word = ''
  let inWord = false
  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index)
    if (char === ' ' || char === '\t' || char === '\n') {
      if (inWord) words.push(word)
      word = ''
      inWord = false
      continue
    }
    inWord = true
    if (char === '\'') {
      const end = command.indexOf('\'', index + 1)
      if (end < 0) return undefined
      word += command.slice(index + 1, end)
      index = end
    } else if (char === '"') {
      let closed = false
      for (index += 1; index < command.length; index += 1) {
        const inner = command.charAt(index)
        if (inner === '"') {
          closed = true
          break
        }
        if (inner === '\\' && index + 1 < command.length && '$`"\\\n'.includes(command.charAt(index + 1))) {
          index += 1
          word += command.charAt(index)
        } else {
          word += inner
        }
      }
      if (!closed) return undefined
    } else if (char === '\\') {
      if (index + 1 >= command.length) return undefined
      index += 1
      word += command.charAt(index)
    } else {
      word += char
    }
  }
  if (inWord) words.push(word)
  return words
}

/**
 * The rule data a command question would carry, when a rule may exist for it at all.
 * @param question - the command question.
 * @returns the data, or undefined for input to a terminal, a sub-command callback, an escalation, a network question,
 *   or a command that does not split into words.
 */
function ruleData(question: CommandQuestion): CommandRuleData | undefined {
  if ((question.kind ?? 'command') !== 'command') return undefined
  if (question.approvalId !== null && question.approvalId !== undefined) return undefined
  if (typeof question.reason === 'string' && question.reason !== '') return undefined
  if (question.networkApprovalContext !== null && question.networkApprovalContext !== undefined) return undefined
  if ((question.proposedNetworkPolicyAmendments ?? []).length > 0) return undefined
  if (typeof question.command !== 'string' || typeof question.cwd !== 'string' || question.cwd === '') return undefined
  const argv = shellWords(question.command)
  if (argv === undefined || argv.length === 0) return undefined
  return { kind: 'command', threadId: question.threadId, argv, cwd: question.cwd, environmentId: question.environmentId ?? null }
}

/**
 * The run rule "Allow for this run" grants for a command question.
 * @param question - the command question.
 * @returns the rule, or undefined when "Allow for this run" is not offered.
 */
export function commandRunRule(question: CommandQuestion): ProgramRunRule | undefined {
  const data = ruleData(question)
  if (data === undefined || typeof question.command !== 'string') return undefined
  return { provider: 'codex', summary: question.command, data: { ...data, argv: [...data.argv] } }
}

/**
 * Whether a rule the person allowed answers a later command question.
 * @param rule - a rule from this run, possibly made by another driver.
 * @param question - the later question.
 * @returns true only for a Codex command rule of the same thread, argv, folder and environment, and a question with no
 *   escalation, network or sub-command field.
 */
export function ruleCovers(rule: ProgramRunRule, question: CommandQuestion): boolean {
  if (rule.provider !== 'codex') return false
  const allowed = CommandRuleData.safeParse(rule.data)
  const asked = ruleData(question)
  if (!allowed.success || asked === undefined) return false
  const { data } = allowed
  return data.threadId === asked.threadId
    && data.cwd === asked.cwd
    && data.environmentId === asked.environmentId
    && data.argv.length === asked.argv.length
    && data.argv.every((word, index) => word === asked.argv[index])
}
