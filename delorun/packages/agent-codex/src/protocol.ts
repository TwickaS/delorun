/**
 * The part of Codex app-server's stable protocol (`experimentalApi: false`) the driver speaks, as zod schemas that
 * validate every frame where it crosses the process boundary. Fields the driver never reads are left out, and objects
 * stay open, so a field Codex adds does not refuse a frame; a field the driver reads with the wrong type does.
 * Personal fields (email, account id, credits) are never declared, so a parsed value cannot carry them.
 *
 * Written against Codex 0.153.4's `app-server generate-ts` output; {@link TESTED_CODEX_VERSION} names that version.
 * @module @delorun/agent-codex/protocol
 */
import { z } from 'zod'

/** The only Codex version this protocol was tested against; any other version is refused before it starts. */
export const TESTED_CODEX_VERSION = '0.153.4'

/** A JSON value parsed from the wire. */
export const JsonSchema: z.ZodType<WireJson> = z.lazy(() => z.union([
  z.string(), z.number(), z.boolean(), z.null(), z.array(JsonSchema), z.record(z.string(), JsonSchema),
]))
/** A JSON value parsed from the wire. */
export type WireJson = string | number | boolean | null | WireJson[] | { [key: string]: WireJson }

const nullableString = z.string().nullable().optional()

/** `initialize`'s result. */
export const InitializeResult = z.looseObject({ userAgent: z.string() })

/** The fields of a `Thread` the driver reads. */
const Thread = z.looseObject({ id: z.string().min(1), model: z.string().nullable().optional() })

/** `thread/start` and `thread/resume` results: the thread and the model it runs. */
export const ThreadOpenResult = z.looseObject({
  thread: Thread,
  model: z.string(),
  approvalPolicy: z.union([z.string(), z.record(z.string(), JsonSchema)]),
  approvalsReviewer: z.string().nullable().optional(),
  sandbox: z.looseObject({ type: z.string() }),
})

/** `config/read`'s result, keeping only the effective approval policy. */
export const ConfigReadResult = z.looseObject({ config: z.looseObject({ approval_policy: JsonSchema.nullable().optional() }) })

/** The error carried by a failed turn or an `error` notification. `codexErrorInfo` is a name or a one-key object. */
export const TurnError = z.looseObject({
  message: z.string(),
  codexErrorInfo: z.union([z.string(), z.record(z.string(), JsonSchema)]).nullable().optional(),
  additionalDetails: nullableString,
})
/** A parsed turn error. */
export type TurnError = z.infer<typeof TurnError>

/** The fields of a `Turn` the driver reads. */
export const Turn = z.looseObject({
  id: z.string().min(1),
  status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']),
  error: TurnError.nullable().optional(),
})

/** `turn/start`'s result. */
export const TurnStartResult = z.looseObject({ turn: Turn })
/** `turn/steer`'s result. */
export const TurnSteerResult = z.looseObject({ turnId: z.string() })
/** `turn/interrupt`'s result, which carries nothing the driver reads. */
export const EmptyResult = z.looseObject({})

/** One `model/list` entry. */
const Model = z.looseObject({ model: z.string().min(1), displayName: z.string(), hidden: z.boolean(), isDefault: z.boolean() })
/** `model/list`'s result, one page. */
export const ModelListResult = z.looseObject({ data: z.array(Model), nextCursor: z.string().nullable().optional() })

/** `account/read`'s result without the email: the sign-in kind and the ChatGPT plan. */
export const AccountReadResult = z.looseObject({
  account: z.looseObject({ type: z.string(), planType: z.string().optional() }).nullable(),
  requiresOpenaiAuth: z.boolean(),
})

/** One rate-limit window. `resetsAt` is in Unix seconds. */
const RateLimitWindow = z.looseObject({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullable().optional(),
  resetsAt: z.number().nullable().optional(),
})
/** A rate-limit snapshot without credits, spend controls or ids. */
export const RateLimitSnapshot = z.looseObject({
  primary: RateLimitWindow.nullable().optional(),
  secondary: RateLimitWindow.nullable().optional(),
  planType: nullableString,
  rateLimitReachedType: nullableString,
})
/** A parsed rate-limit snapshot. */
export type RateLimitSnapshot = z.infer<typeof RateLimitSnapshot>
/** `account/rateLimits/read`'s result, keeping only the default snapshot (the account id is never declared). */
export const RateLimitsReadResult = z.looseObject({ rateLimits: RateLimitSnapshot })

/** The results of every client request the driver sends, by method. */
export const RESULTS = {
  initialize: InitializeResult,
  'thread/start': ThreadOpenResult,
  'thread/resume': ThreadOpenResult,
  'turn/start': TurnStartResult,
  'turn/steer': TurnSteerResult,
  'turn/interrupt': EmptyResult,
  'model/list': ModelListResult,
  'account/read': AccountReadResult,
  'account/rateLimits/read': RateLimitsReadResult,
  'config/read': ConfigReadResult,
} as const

/** A client request method the driver sends. */
export type ClientMethod = keyof typeof RESULTS
/** The parsed result of one client request method. */
export type ClientResult<M extends ClientMethod> = z.infer<(typeof RESULTS)[M]>

const CommandExecutionItem = z.looseObject({
  type: z.literal('commandExecution'),
  id: z.string(),
  command: z.string(),
  cwd: z.string(),
  status: z.string(),
  aggregatedOutput: nullableString,
  exitCode: z.number().nullable().optional(),
})
const FileChangeItem = z.looseObject({
  type: z.literal('fileChange'),
  id: z.string(),
  changes: z.array(z.looseObject({ path: z.string(), kind: JsonSchema, diff: z.string() })),
  status: z.string(),
})
const McpToolCallItem = z.looseObject({
  type: z.literal('mcpToolCall'),
  id: z.string(),
  server: z.string(),
  tool: z.string(),
  status: z.string(),
  arguments: JsonSchema,
  result: z.looseObject({ content: z.array(JsonSchema) }).nullable().optional(),
  error: z.looseObject({ message: z.string() }).nullable().optional(),
})
const WebSearchItem = z.looseObject({ type: z.literal('webSearch'), id: z.string(), query: z.string() })
const AgentMessageItem = z.looseObject({ type: z.literal('agentMessage'), id: z.string(), text: z.string() })
const ReasoningItem = z.looseObject({ type: z.literal('reasoning'), id: z.string(), summary: z.array(z.string()), content: z.array(z.string()) })

/** A thread item the driver maps; any other item type is not shown. */
export const MappedItem = z.discriminatedUnion('type', [CommandExecutionItem, FileChangeItem, McpToolCallItem, WebSearchItem, AgentMessageItem, ReasoningItem])
/** A parsed mapped item. */
export type MappedItem = z.infer<typeof MappedItem>
/** A mapped item that is one of the program's own tool calls. */
export type ToolItem = Exclude<MappedItem, { readonly type: 'agentMessage' | 'reasoning' }>
/** The item types that are tool calls. */
export const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'])

/** Any thread item: the type and id, checked before the item is parsed as a {@link MappedItem}. */
const AnyItem = z.looseObject({ type: z.string(), id: z.string() })

const ItemNotification = z.looseObject({ threadId: z.string(), turnId: z.string(), item: AnyItem })
const TokenUsageBreakdown = z.looseObject({
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheWriteInputTokens: z.number().optional(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
})
/** A parsed token-usage breakdown. */
export type TokenUsageBreakdown = z.infer<typeof TokenUsageBreakdown>

/** The server notifications the driver reads, by method; any other method is ignored. */
export const NOTIFICATIONS = {
  'turn/started': z.looseObject({ threadId: z.string(), turn: Turn }),
  'turn/completed': z.looseObject({ threadId: z.string(), turn: Turn }),
  'item/started': ItemNotification,
  'item/completed': ItemNotification,
  'thread/tokenUsage/updated': z.looseObject({ threadId: z.string(), turnId: z.string(), tokenUsage: z.looseObject({ last: TokenUsageBreakdown }) }),
  'account/rateLimits/updated': z.looseObject({ rateLimits: RateLimitSnapshot }),
  error: z.looseObject({ error: TurnError, willRetry: z.boolean(), threadId: z.string(), turnId: z.string() }),
  'serverRequest/resolved': z.looseObject({ threadId: z.string(), requestId: z.union([z.string(), z.number()]) }),
} as const

/** A notification method the driver reads. */
export type NotificationMethod = keyof typeof NOTIFICATIONS
/** One parsed notification, discriminated by method. */
export type CodexNotification = { [M in NotificationMethod]: { readonly method: M; readonly params: z.infer<(typeof NOTIFICATIONS)[M]> } }[NotificationMethod]

/** The server requests the driver answers, by method; any other method is refused with a JSON-RPC error. */
export const SERVER_REQUESTS = {
  'item/commandExecution/requestApproval': z.looseObject({
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    kind: z.enum(['command', 'writeStdin']).optional(),
    approvalId: nullableString,
    reason: nullableString,
    command: nullableString,
    cwd: nullableString,
    environmentId: nullableString,
    networkApprovalContext: z.looseObject({ host: z.string() }).nullable().optional(),
    proposedNetworkPolicyAmendments: z.array(JsonSchema).nullable().optional(),
  }),
  'item/fileChange/requestApproval': z.looseObject({
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    reason: nullableString,
    grantRoot: nullableString,
  }),
  'item/permissions/requestApproval': z.looseObject({ threadId: z.string(), turnId: z.string(), itemId: z.string() }),
  'mcpServer/elicitation/request': z.looseObject({
    threadId: z.string(),
    turnId: z.string().nullable(),
    serverName: z.string(),
    mode: z.string(),
    message: z.string(),
    _meta: JsonSchema.optional(),
  }),
} as const

/** A server request method the driver answers. */
export type ServerRequestMethod = keyof typeof SERVER_REQUESTS
/** One parsed server request, discriminated by method. */
export type CodexServerRequest = { [M in ServerRequestMethod]: { readonly method: M; readonly params: z.infer<(typeof SERVER_REQUESTS)[M]> } }[ServerRequestMethod]
