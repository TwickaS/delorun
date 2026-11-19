/**
 * Frames recorded from the pinned Codex 0.153.4 app-server in the Stage 0 proof's live runs (logs
 * `codex-approvals`, `codex-interrupt`, `codex-signin` and `codex-limits`), trimmed to the fields that matter and with
 * the task folder, Codex home and ids replaced. The proof's log redacted token usage, so {@link tokenUsage} follows the
 * generated schema instead.
 * @module @delorun/agent-codex/tests/recorded
 */
import type { Frame } from './fake-app-server.ts'

export const THREAD = '01a1ea16-4cd0-7fd2-811a-43844475398d'
export const TURN = '01a1ea16-86ba-7861-a8a8-9b6990978552'
export const NEXT_TURN = '01a1ea16-9e84-7371-8014-3b5a9892bbca'
export const TASK = '/work/task'
export const EXEC = 'exec-9eff672d-56e8-48c2-909c-10f361e02811'
export const COMMAND = "/usr/bin/zsh -lc 'touch made-by-codex.txt'"

export const initializeResult: Frame = {
  userAgent: 'delorun/0.153.4 (Ubuntu 24.4.0; x86_64) xterm-256color (delorun; 0.1.0)',
  codexHome: '/home/person/.codex',
  platformFamily: 'unix',
  platformOs: 'linux',
}

export const accountSignedIn: Frame = { account: { type: 'chatgpt', email: 'person@example.invalid', planType: 'free' }, requiresOpenaiAuth: true }
export const accountSignedOut: Frame = { account: null, requiresOpenaiAuth: true }

/** A `thread/start` result for a thread running `model`. */
export function threadOpened(model: string, id = THREAD): Frame {
  return {
    thread: { id, sessionId: id, ephemeral: false, modelProvider: 'openai', model, status: { type: 'idle' }, cwd: TASK, cliVersion: '0.153.4', turns: [] },
    model,
    modelProvider: 'openai',
    cwd: TASK,
    approvalPolicy: 'untrusted',
    sandbox: { type: 'readOnly', networkAccess: false },
    reasoningEffort: 'low',
  }
}

/** `model/list` on the proof's ChatGPT free plan, without hidden entries. */
export const modelList: Frame = {
  data: [
    { id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: '', hidden: false, isDefault: true, upgrade: null },
    { id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', description: '', hidden: false, isDefault: false, upgrade: null },
    { id: 'gpt-reserve', model: 'gpt-reserve', displayName: 'Reserve', description: '', hidden: true, isDefault: false, upgrade: null },
  ],
  nextCursor: null,
}

/** A turn in a turn frame. */
export function turn(id: string, status: string, error: Frame | null = null): Frame {
  return { id, items: [], itemsView: 'notLoaded', status, error, startedAt: null, completedAt: null, durationMs: null }
}

export const turnStarted = (id = TURN): Frame => ({ threadId: THREAD, turn: turn(id, 'inProgress') })
export const turnCompleted = (status: string, id = TURN, error: Frame | null = null): Frame => ({ threadId: THREAD, turn: turn(id, status, error) })

/** A `commandExecution` item, as `item/started` and `item/completed` carry it. */
export function commandItem(status: 'inProgress' | 'completed' | 'declined' | 'failed', exitCode: number | null = null, id = EXEC, command = COMMAND): Frame {
  return {
    type: 'commandExecution', id, pluginId: null, scriptPath: null, command, cwd: TASK, processId: null, source: 'agent', status,
    commandActions: [{ type: 'unknown', command: 'touch made-by-codex.txt' }], aggregatedOutput: null, exitCode, durationMs: null,
  }
}

export const itemFrame = (item: Frame, turnId = TURN): Frame => ({ item, threadId: THREAD, turnId, startedAtMs: 1794928711715 })

/** The approval request recorded 1 ms after the command's `item/started`. */
export function commandApproval(itemId = EXEC, command = COMMAND): Frame {
  return {
    kind: 'command', threadId: THREAD, turnId: TURN, itemId, startedAtMs: 1794928711713, environmentId: 'local', command, cwd: TASK,
    commandActions: [{ type: 'unknown', command: 'touch made-by-codex.txt' }],
    proposedExecpolicyAmendment: ['touch', 'made-by-codex.txt'],
    availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'made-by-codex.txt'] } }, 'cancel'],
  }
}

/** `thread/tokenUsage/updated` after one model request. */
export function tokenUsage(input: number, cached: number, output: number, turnId = TURN): Frame {
  const last = { totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 3 }
  return { threadId: THREAD, turnId, tokenUsage: { total: last, last, modelContextWindow: 272_000 } }
}

/** The proof's rate-limit snapshot on a free plan, with the fields the driver must never pass on. */
export function rateLimits(usedPercent = 0, rateLimitReachedType: string | null = null): Frame {
  return {
    limitId: 'codex', limitName: null,
    primary: { usedPercent, windowDurationMins: 43200, resetsAt: 1797520635 },
    secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1794940000 },
    credits: { hasCredits: false, unlimited: false, balance: null }, individualLimit: null, spendControlReached: null,
    planType: 'free', rateLimitReachedType,
  }
}

/** The proof's `account/rateLimits/read` result, account id included as Codex sends it. */
export const rateLimitsRead: Frame = { rateLimits: rateLimits(2), rateLimitsByLimitId: null, rateLimitResetCredits: { availableCount: 0, credits: [] }, accountId: 'acct-person', rateLimitUpsell: null }

/** The turn error the proof saw when the person's configured model was not on the plan. */
export const modelNotFound: Frame = {
  message: '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-astra\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}',
  codexErrorInfo: 'other', additionalDetails: null, misalignment: null,
}
