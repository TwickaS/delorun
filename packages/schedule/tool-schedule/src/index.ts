/**
 * Model-facing `schedule_create`, `schedule_list`, `schedule_view`, and
 * `schedule_edit` tools over the Host `ctx.schedule` service. Mounting the
 * plugin registers them in the mounting scope, so a preset decides which
 * agents receive them. Tasks belong to the Host, not to a Session: the tools
 * read and change any task by id, and only the delivery target names a Session.
 * @module @deepseek-ai/dsh-tool-schedule
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: make `ctx.get('agentPresets')` resolve to the preset roster when
// composed. A rosterless deployment records no preset for a created Session.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, MAX_TITLE_LENGTH, MIN_EVERY_INTERVAL_SECONDS, ScheduleId, ScheduleInputError,
  formatScheduleLocalTime,
} from '@deepseek-ai/dsh-schedule'
import type { SchedulePermissionPresets } from '@deepseek-ai/dsh-schedule'
import type {
  InternalScheduleError, ScheduleConsentApproval, ScheduleConsentRefusal, ScheduleEditRequest, ScheduleEffect, ScheduleRecord,
  ScheduleSessionCreateSpec, ScheduleTarget, ScheduleTargetRequest, ScheduleToolError,
  ScheduleCatalogEntry, ScheduleDeliveryReceipt, SubagentSessionError,
} from '@deepseek-ai/dsh-schedule'

/** Plugin name registered with the Loader. */
export const name = 'tool-schedule'

/** Host services this plugin consumes. The Schedule service is resolved per
 * scope, so a preset that declares this plugin stays inert while the shipped
 * composition keeps that service off. */
export const inject = ['tools', 'systemPrompt']

const SESSION_CREATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cwd: { type: 'string' },
    agentPreset: { type: 'string' },
  },
} as const

const TARGET_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'session' },
        sessionId: { type: 'string', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'new_once' },
        sessionId: { type: 'string', required: true },
        create: { ...SESSION_CREATE_SCHEMA, required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'new' },
        create: { ...SESSION_CREATE_SCHEMA, required: true },
      },
    },
  ],
} as const

const DELIVERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scheduledAt: { type: 'string', required: true },
    deliveredAt: { type: 'string', required: true },
    targetSessionId: { type: 'string', required: true },
  },
} as const

const TASK_PROPERTIES = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    prompt: { type: 'string', required: true },
    scheduledAt: { type: 'string', required: true },
    scheduledAtLocal: { type: 'string', required: true },
    target: { ...TARGET_SCHEMA, required: true },
    status: { type: 'string', required: true, enum: ['active', 'paused', 'ended'] },
    updatedAt: { type: 'string' },
    lastDelivery: DELIVERY_SCHEMA,
  },
} as const

const TASK_SCHEMA = {
  oneOf: [
    { ...TASK_PROPERTIES, properties: { ...TASK_PROPERTIES.properties, kind: { type: 'string', required: true, const: 'rrule' }, rrule: { type: 'string', required: true } } },
    { ...TASK_PROPERTIES, properties: { ...TASK_PROPERTIES.properties, kind: { type: 'string', required: true, const: 'cron' }, expression: { type: 'string', required: true }, timeZone: { type: 'string', required: true } } },
    { ...TASK_PROPERTIES, properties: { ...TASK_PROPERTIES.properties, kind: { type: 'string', required: true, const: 'every' }, everySeconds: { type: 'integer', required: true } } },
    { ...TASK_PROPERTIES, properties: { ...TASK_PROPERTIES.properties, kind: { type: 'string', required: true, const: 'after' }, afterSeconds: { type: 'integer', required: true } } },
    { ...TASK_PROPERTIES, properties: { ...TASK_PROPERTIES.properties, kind: { type: 'string', required: true, const: 'at' } } },
    { ...TASK_PROPERTIES, properties: { ...TASK_PROPERTIES.properties, kind: { type: 'string', required: true, const: 'daily' }, time: { type: 'string', required: true }, timeZone: { type: 'string', required: true } } },
    { ...TASK_PROPERTIES, properties: { ...TASK_PROPERTIES.properties, kind: { type: 'string', required: true, const: 'weekly' }, time: { type: 'string', required: true }, timeZone: { type: 'string', required: true }, weekdays: { type: 'array', required: true, items: { type: 'integer' } } } },
  ],
} as const

const LIST_PAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', required: true, items: TASK_SCHEMA },
    shown: { type: 'integer', required: true },
    total: { type: 'integer', required: true },
    limit: { type: 'integer', required: true },
    offset: { type: 'integer', required: true },
  },
} as const

const NOT_FOUND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    code: { type: 'string', required: true, const: 'schedule_not_found' },
  },
} as const

const DELETED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    deleted: { type: 'boolean', required: true, const: true },
  },
} as const

const CONFLICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    code: { type: 'string', required: true, const: 'schedule_conflict' },
  },
} as const

/** Errors every tool can return: a delegated caller and a withheld failure. */
const CALLER_ERRORS = ['subagent_session', 'internal_error'] as const

/** Errors of a new title, prompt, or recurrence. */
const CREATE_ERRORS = [
  'invalid_prompt', 'invalid_rule', 'invalid_time_zone', 'not_future', 'frequency_too_high', ...CALLER_ERRORS,
] as const

/** Errors of an invalid page request. */
const LIST_ERRORS = ['invalid_rule', ...CALLER_ERRORS] as const

/** Errors of a changed field or an invalid field combination. */
const EDIT_ERRORS = ['invalid_selector', ...CREATE_ERRORS] as const

/** Error result of one tool, limited to the codes that its output schema declares. */
interface DeclaredError<C extends ScheduleToolError['code']> {
  readonly code: C
  readonly message: string
}

/** Build the exact two-field error schema of one tool from the codes it can return. */
function errorSchema<const C extends ScheduleToolError['code']>(codes: readonly C[]) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: { type: 'string', required: true, enum: codes },
      message: { type: 'string', required: true },
    },
  } as const
}

const CREATE_OUTPUT_SCHEMA = { oneOf: [TASK_SCHEMA, errorSchema(CREATE_ERRORS)] } as const
const LIST_OUTPUT_SCHEMA = { oneOf: [LIST_PAGE_SCHEMA, errorSchema(LIST_ERRORS)] } as const
const VIEW_OUTPUT_SCHEMA = { oneOf: [TASK_SCHEMA, NOT_FOUND_SCHEMA, errorSchema(CALLER_ERRORS)] } as const
const EDIT_OUTPUT_SCHEMA = {
  oneOf: [TASK_SCHEMA, DELETED_SCHEMA, NOT_FOUND_SCHEMA, CONFLICT_SCHEMA, errorSchema(EDIT_ERRORS)],
} as const

const MANAGEMENT_AUTHORIZATION =
  'Only create or modify scheduled tasks at the user\'s explicit request; '
  + 'prior explicit user authorization for the running scheduled task remains valid.'

const CREATE_DESCRIPTION =
  'Create a scheduled task. At each occurrence of rrule, prompt is delivered to the target session '
  + 'as a scheduled message from the user. The result includes the task id and the next occurrence as scheduledAt in UTC '
  + 'and scheduledAtLocal in the zone of rrule. '
  + 'After downtime, only the latest missed occurrence is delivered. Delivery can repeat after a crash.'

const LIST_DESCRIPTION =
  'List scheduled tasks, including tasks created from other sessions. Active tasks come first, ordered by scheduledAt.'

const VIEW_DESCRIPTION = 'View one scheduled task by id.'

const EDIT_DESCRIPTION = 'Update, pause, resume, or delete one scheduled task by id. Deleting does not retract queued messages.'

const TITLE_HELP = `Task name of at most ${MAX_TITLE_LENGTH} characters in the user's language: action plus object. `
  + 'Omit timing, status, ids, and bracketed suffixes.'

const RRULE_HELP =
  'Supported RFC 5545 subset: one DTSTART line, a newline, and one RRULE line. '
  + 'DTSTART ends in Z for UTC or carries TZID with an IANA time zone; '
  + 'a fixed offset such as UTC+5 is Etc/GMT-5, with the sign reversed. '
  + 'DTSTART must name an existing local time. A TZID rule keeps local clock time across daylight-saving changes; '
  + 'generated nonexistent local times are skipped, and repeated ones occur once, at the earlier instant. '
  + 'DTSTART may be in the past; delivery starts with the first occurrence after creation. '
  + 'A one-time delivery is RRULE:FREQ=DAILY;COUNT=1. '
  + 'No SECONDLY; BYSECOND takes one value. COUNT is at most 1000; use UNTIL for longer rules. '
  + 'MINUTELY and HOURLY accept no BY parts, so select clock times with DAILY or WEEKLY plus BYHOUR and BYMINUTE. '
  + 'BYMONTHDAY and ordinal BYDAY require MONTHLY or YEARLY; BYYEARDAY and BYWEEKNO require YEARLY. '
  + 'Ordinal BYDAY cannot combine with BYWEEKNO. Each FREQ period allows at most 10080 candidates before BYSETPOS, '
  + 'which accepts at most 31 values. '
  + 'UNTIL is a UTC instant ending in Z. '
  + 'Example: "DTSTART;TZID=Asia/Singapore:20260901T080000\\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1"'

const TARGET_CHOICES = ['this_session', 'new_once', 'new'] as const

/**
 * Describe the target choices, naming the configured spacing of `new` deliveries when it exceeds the one-minute
 * spacing of every task.
 * @param newSessionIntervalSeconds - Effective `newSessionIntervalSeconds` of the Host Schedule service.
 * @returns The `target` parameter description.
 */
function targetHelp(newSessionIntervalSeconds: number): string {
  const spacing = newSessionIntervalSeconds <= MIN_EVERY_INTERVAL_SECONDS
    ? ''
    : newSessionIntervalSeconds % 60 === 0
      ? `, at most once every ${newSessionIntervalSeconds / 60} minutes`
      : `, at most once every ${newSessionIntervalSeconds} seconds`
  return 'this_session delivers to this session; '
    + 'new_once delivers to the same new session every time, opened at the first delivery; new opens a different '
    + `new session for every delivery${spacing}. New sessions use this session's working directory and preset. `
    + 'With this_session or new_once, a delivery waits until the previous one finishes, and only the latest occurrence '
    + 'that passed meanwhile is delivered. '
    + 'Use this_session for reminders and for follow-ups to this conversation; use new_once or new for independent work, '
    + 'such as a recurring report, and whenever the user asks for a new conversation.'
}

/** Edit parameters that only an update accepts. */
const PATCH_FIELDS = ['title', 'prompt', 'rrule', 'target', 'active'] as const

/** Deterministic model content for every canonical Schedule value. */
function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  // The ToolRuntime has already validated the value against the lossless-JSON output schema.
  const text = JSON.stringify(value)
  return [{ type: 'text', text }]
}

/** Authoritative timing and management fields, without Host delivery bookkeeping. */
type ModelTask = ScheduleRecord & Pick<ScheduleCatalogEntry, 'target' | 'status' | 'updatedAt'> & {
  readonly scheduledAtLocal: string
  readonly lastDelivery?: Pick<ScheduleDeliveryReceipt, 'scheduledAt' | 'deliveredAt' | 'targetSessionId'>
}

/** Preserve timing, destination, and edit revision while withholding Host bookkeeping. */
function modelTask(task: ScheduleCatalogEntry): ModelTask {
  const { involvedSessionIds: _involved, createdAt: _created, executionActive: _execution,
    deliveryFloorEndsAt: _floor, consentRefusal: _refusal, lastDelivery, ...record } = task
  return {
    ...record, scheduledAtLocal: formatScheduleLocalTime(task, task.scheduledAt),
    ...lastDelivery === undefined ? {} : { lastDelivery: {
      scheduledAt: lastDelivery.scheduledAt, deliveredAt: lastDelivery.deliveredAt, targetSessionId: lastDelivery.targetSessionId,
    } },
  }
}

/** Pure generic pending card. */
function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/** The rule text a consent names, from a stored record the caller does not restate. */
function recurrenceText(record: ScheduleRecord): string {
  switch (record.kind) {
    case 'rrule': return record.rrule
    case 'cron': return record.expression
    case 'daily': return `daily at ${record.time} (${record.timeZone})`
    case 'weekly': return `weekly at ${record.time} (${record.timeZone})`
    case 'every': return `every ${record.everySeconds} seconds`
    default: return record.scheduledAt
  }
}

/** Longest task title, instruction excerpt, chat title or directory an approval names. */
const MAX_FACT_LENGTH = 200

/**
 * One text fact as an approval states it: control and format characters, which could break or disguise the
 * sentence, become spaces, runs of whitespace collapse, and a fact longer than {@link MAX_FACT_LENGTH} ends in an
 * ellipsis.
 * @param text - The text as stored or as the caller wrote it.
 * @returns The bounded, printable fact.
 */
function shownFact(text: string): string {
  const plain = text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()
  return plain.length <= MAX_FACT_LENGTH ? plain : `${plain.slice(0, MAX_FACT_LENGTH - 1)}…`
}

/** The target facts a consent names: the chat the deliveries reach, its title or directory, and the preset it runs. */
interface TargetFacts {
  readonly targetSessionId: ScheduleEffect['targetSessionId']
  readonly targetTitle: string | undefined
  readonly targetCwd: string | undefined
  readonly targetPreset: string | undefined
}

/**
 * The facts of a destination that opens its own Session: no chat yet, the directory it opens in, and the preset it
 * will be opened under — the one the consent names for those creation values, such as its Workspace's, or the
 * deployment default every fresh Session is pinned to, never the caller's.
 * @param ctx - Scope holding the preset service and the consent.
 * @param create - Creation values of the Session a delivery opens.
 * @returns The facts the approval names.
 */
function createdFacts(ctx: Context, create: ScheduleSessionCreateSpec): TargetFacts {
  const presets = ctx.get('permissionPresets') as SchedulePermissionPresets | undefined
  return {
    targetSessionId: undefined,
    targetTitle: undefined,
    targetCwd: create.cwd === undefined ? undefined : shownFact(create.cwd),
    targetPreset: presets === undefined ? undefined : ctx.get('scheduleConsent')?.presetFor?.(create) ?? presets.defaultPreset,
  }
}

/**
 * The facts of a live or stored chat the deliveries reach.
 * @param ctx - Scope holding the preset service and the chat titles.
 * @param sessionId - The chat.
 * @param agent - Its live Agent; without one, neither its title nor its preset can be read.
 * @returns The facts the approval names.
 */
function chatFacts(ctx: Context, sessionId: string, agent: Agent | undefined): TargetFacts {
  const presets = ctx.get('permissionPresets') as SchedulePermissionPresets | undefined
  const title = agent === undefined ? undefined : ctx.get('sessionTitle')?.get(agent.session)?.title
  return {
    targetSessionId: sessionId,
    targetTitle: title === undefined ? undefined : shownFact(title),
    targetCwd: undefined,
    targetPreset: agent === undefined ? undefined : presets?.current(agent.session),
  }
}

/**
 * The target facts a consent names, resolved from one model target choice.
 * @param ctx - Scope whose preset service knows the presets.
 * @param agent - Calling root Agent.
 * @param target - Model target choice of the pending call.
 * @returns The chat the deliveries reach and the preset it runs.
 */
function targetFacts(ctx: Context, agent: Agent, target: typeof TARGET_CHOICES[number]): TargetFacts {
  return target === 'this_session' ? chatFacts(ctx, agent.session.id, agent) : createdFacts(ctx, createSpecFor(agent))
}

/**
 * The target facts of a stored destination the pending call keeps.
 *
 * A stored Session target with no live Agent runs no readable preset: the approval names none
 * rather than the caller's, which is a different chat's.
 * @param ctx - Scope whose live Agent registry supplies a stored target's Session.
 * @param target - Destination stored on the task.
 * @returns The chat the deliveries reach and the preset it runs.
 */
function storedFacts(ctx: Context, target: ScheduleTarget): TargetFacts {
  return target.kind === 'session'
    ? chatFacts(ctx, target.sessionId, ctx.agents.get(target.sessionId))
    : createdFacts(ctx, target.create)
}

/** What one pending management call puts to the composed consent. */
interface ConsentFacts {
  /** The effect the consent names: the recurrence the call arms or keeps. */
  readonly effect: ScheduleEffect | undefined
  /** The refusal the consent recorded on the edited task, which this edit puts to the person again. */
  readonly refusal: ScheduleConsentRefusal | undefined
}

/**
 * Read the facts one Schedule management call puts to the consent. An update names what the task
 * will be after it: the title, instruction, rule and target the call restates, and the stored ones
 * it keeps, so an edit of the instruction alone still states a changed fact. A task that cannot be
 * read leaves the approval unnamed, and a delete creates no effect to name at all. An edit of a task
 * the consent refused reports that refusal, so the ask states why the delivery stopped before the
 * person re-approves it. The arguments are the model's JSON before the tool's schema checks them.
 * @param ctx - Scope whose `schedule` service stores the tasks.
 * @param exec - Pending management call with its parsed arguments.
 * @param agent - Calling root Agent.
 * @returns The effect and the edited task's stored refusal; both are undefined when the call names no effect.
 */
async function consentFacts(ctx: Context, exec: ToolExecution, agent: Agent): Promise<ConsentFacts> {
  const args = exec.arguments as {
    title?: unknown
    prompt?: unknown
    rrule?: unknown
    target?: unknown
    id?: unknown
    action?: unknown
  } | undefined
  const none: ConsentFacts = { effect: undefined, refusal: undefined }
  if (args === undefined || typeof args !== 'object') return none
  // A delete only removes the task: nothing starts delivering, so the approval states nothing.
  if (exec.name === 'schedule_edit' && args.action === 'delete') return none
  const stated = (value: unknown, kept: string): string => shownFact(typeof value === 'string' ? value : kept)
  let tool: ScheduleEffect['tool']
  let title: string
  let prompt: string
  let recurrence: string
  let facts: TargetFacts
  let refusal: ScheduleConsentRefusal | undefined
  if (exec.name === 'schedule_create') {
    tool = 'schedule_create'
    if (typeof args.rrule !== 'string') return none
    title = stated(args.title, '')
    prompt = stated(args.prompt, '')
    recurrence = args.rrule
    facts = targetFacts(ctx, agent, typeof args.target === 'string'
      ? args.target as typeof TARGET_CHOICES[number]
      : 'new_once')
  } else {
    if (typeof args.id !== 'string') return none
    tool = 'schedule_edit'
    const stored = await ctx.schedule.view({ id: ScheduleId(args.id) })
    // A lookup miss names no task, so the approval states neither an effect nor a refusal; every stored task states
    // its rule, and the refusal a paused one carries, so the person sees why the delivery stopped before they
    // re-approve it.
    if ('code' in stored) return none
    refusal = stored.consentRefusal
    title = stated(args.title, stored.title)
    prompt = stated(args.prompt, stored.prompt)
    recurrence = typeof args.rrule === 'string' ? args.rrule : recurrenceText(stored)
    facts = typeof args.target === 'string'
      ? targetFacts(ctx, agent, args.target as typeof TARGET_CHOICES[number])
      : storedFacts(ctx, stored.target)
  }
  return { effect: { tool, title, prompt, recurrence, ...facts }, refusal }
}

/** The ask text a mounted consent uses when it names no effect of its own. */
const UNNAMED_CONSENT_ASK = 'The composed scheduled-task consent reviews this change before its deliveries run.'

/** The ask text that puts a recorded refusal back to the person. */
function refusalText(refusal: ScheduleConsentRefusal): string {
  return `The consent refused this task's delivery at ${refusal.refusedAt}: ${refusal.reason}`
}

/**
 * The calls this plugin raised a consent ask for, with the effect each ask named. A `tools/pre-execute`
 * `ask` runs the body only after the approval service answered `allowed-once` and denies every other
 * outcome, so a call that reaches its body with an entry here was answered by the person for exactly
 * that effect, whose preset becomes the task's delivery baseline.
 */
const consentAsks = new WeakMap<ToolExecution, ScheduleEffect>()

/**
 * The person's answer to the consent ask one call passed, when it passed one.
 * @param exec - The executing call.
 * @returns The approval, binding the baseline to the preset the ask named, or undefined.
 */
function approvalOf(exec: ToolRunContext): ScheduleConsentApproval | undefined {
  const effect = consentAsks.get(exec)
  return effect === undefined ? undefined : { preset: effect.targetPreset }
}

/** Stable error for failures not safe to expose. */
function internalError(): InternalScheduleError {
  return { code: 'internal_error', message: 'The schedule operation failed.' }
}

/**
 * Run one Schedule operation for the root Agent that dispatched the call.
 *
 * A delegated subagent cannot use scheduled tasks, so every tool refuses it here even when its preset exposes the
 * tool. An input error keeps its code when the tool declares that code; every other failure becomes `internal_error`.
 * @param exec - Run context of the call.
 * @param codes - Error codes of the tool.
 * @param operation - Service call for the calling Agent.
 * @returns The operation result, or an error with a declared code.
 */
async function runForCaller<T, const C extends ScheduleToolError['code']>(
  exec: ToolRunContext,
  codes: readonly C[],
  operation: (agent: Agent) => Promise<T>,
): Promise<T | DeclaredError<C> | SubagentSessionError | InternalScheduleError> {
  const agent = exec.agent
  if (agent === undefined) return internalError()
  if (delegationDepthOf(agent) > 0) {
    return { code: 'subagent_session', message: 'A delegated subagent cannot use scheduled tasks.' }
  }
  try {
    return await operation(agent)
  } catch (error: unknown) {
    if (error instanceof ScheduleInputError) {
      const code = codes.find(code => code === error.code)
      if (code !== undefined) return { code, message: error.message }
    }
    return internalError()
  }
}

/**
 * Resolve one model target choice to a delivery destination.
 *
 * A created Session uses the caller's working directory and current composed preset; a preset selection in an
 * empty Session changes that composition without rewriting the Session header.
 * @param agent - Calling root Agent.
 * @param target - Model target choice.
 * @returns Destination request for the Schedule service.
 */
function targetFor(agent: Agent, target: typeof TARGET_CHOICES[number]): ScheduleTargetRequest {
  if (target === 'this_session') return { kind: 'session', sessionId: agent.session.id }
  return { kind: target, create: createSpecFor(agent) }
}

/**
 * The creation values of a Session a delivery opens for the calling Agent: its working directory and current
 * composed preset.
 * @param agent - Calling root Agent.
 * @returns The creation values.
 */
function createSpecFor(agent: Agent): ScheduleSessionCreateSpec {
  const cwd = agent.session.header.cwd
  const agentPreset = agent.ctx.get('agentPresets')?.composedPreset(agent.ctx)
  return {
    ...(cwd === undefined ? {} : { cwd }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
  }
}

/**
 * Register the four Schedule tools and shared guidance in the mounting scope.
 *
 * Each call acts for the Agent that dispatched it, so a mount outside an
 * agent scope still registers the tools but every call without a caller Agent
 * is refused as an internal failure. The consent naming reads the live Agent
 * registry to resolve a stored target's Session, so registration waits for it.
 * @param ctx - Context owning the tool and system-prompt registries and the Host Schedule service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['schedule', 'agents'], registerScheduleTools)
}

/**
 * Register the tools and shared guidance in the scope that resolved Schedule.
 * @param ctx - Scope whose `schedule` service the tools act through.
 */
function registerScheduleTools(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:schedule',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SCHEDULE'),
    text: ({ scope }) => ctx.tools.get('schedule_create', scope) !== undefined
      || ctx.tools.get('schedule_edit', scope) !== undefined
      ? MANAGEMENT_AUTHORIZATION
      : '',
  })

  // The consent seam is resolved per call, so a plugin that mounts or disposes it mid-session
  // changes only the later approvals. A mounted consent IS the gate: an `allow` the policy
  // resolved becomes the consent's ask, because a mount with no producer of asks would leave
  // every management call unasked; an ask that already exists gains the consent's naming, so the
  // person sees the recurrence, the chat and the preset the call would start delivering to. The
  // record of that ask is what lets the tool tell the service the person approved *this* edit.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const gate = await next()
    if ((gate.kind !== 'allow' && gate.kind !== 'ask')
      || (exec.name !== 'schedule_create' && exec.name !== 'schedule_edit')) return gate
    const consent = ctx.get('scheduleConsent')
    const agent = exec.agent
    if (consent === undefined || agent === undefined) return gate
    const { effect, refusal } = await consentFacts(ctx, exec, agent)
    if (effect === undefined) return gate
    // A consent that throws here fails the call before anything is asked or stored. It names a copy, so it cannot
    // change the preset this call binds as the baseline.
    const named = consent.nameEffect({ ...effect })
    // A whitespace-only naming names nothing, so the ask never ends in a blank sentence.
    const stated = [named, refusal === undefined ? undefined : refusalText(refusal)]
      .filter((part): part is string => part !== undefined && part.trim() !== '')
    if (gate.kind === 'ask') {
      // Another composed policy asked without the consent's text, so the consent took no part in it.
      if (stated.length === 0) return gate
      consentAsks.set(exec, effect)
      return { ...gate, reason: gate.reason === undefined ? stated.join(' ') : `${gate.reason} ${stated.join(' ')}` }
    }
    // An edit of a task the consent refused is approved again only by an answer to this ask, so the
    // service learns about it the same way it learns about every other consent ask.
    consentAsks.set(exec, effect)
    return { kind: 'ask', reason: stated.length === 0 ? UNNAMED_CONSENT_ASK : stated.join(' ') }
  })

  // Plugin configuration is fixed for the life of the Host service, so the description is read once.
  const targetDescription = targetHelp(ctx.schedule.deliveryLimits().newSessionIntervalSeconds)

  ctx.tools.register(defineTool({
    name: 'schedule_create',
    description: CREATE_DESCRIPTION,
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: TITLE_HELP,
      },
      prompt: { type: 'string', required: true, description: 'Instruction delivered at each occurrence.' },
      rrule: { type: 'string', required: true, description: RRULE_HELP },
      target: { type: 'string', required: true, enum: TARGET_CHOICES, description: targetDescription },
    },
    output: { schema: CREATE_OUTPUT_SCHEMA, render: renderValue },
    execute(args, exec) {
      return runForCaller(exec, CREATE_ERRORS, agent => ctx.schedule.create({
        title: args.title, prompt: args.prompt, timing: { kind: 'rrule', rrule: args.rrule }, target: targetFor(agent, args.target),
      }, agent.session.id, exec.signal, approvalOf(exec)).then(modelTask))
    },
    presentCall: args => present('Create scheduled task', 'other', args.title),
  }))

  ctx.tools.register(defineTool({
    name: 'schedule_list',
    description: LIST_DESCRIPTION,
    parameters: {
      active: {
        type: 'boolean',
        description: 'true for active tasks only; false for paused and ended tasks only; omitted for all tasks.',
      },
      limit: { type: 'integer', description: `Page size from 1 to ${MAX_LIST_LIMIT}; defaults to ${DEFAULT_LIST_LIMIT}.` },
      offset: { type: 'integer', description: 'Number of tasks to skip; defaults to 0.' },
    },
    output: { schema: LIST_OUTPUT_SCHEMA, render: renderValue },
    // Host task reads activate no target Session.
    isConcurrencySafe: () => true,
    execute({ active, limit, offset }, exec) {
      // The open parameter root admits unknown keys; only the declared page fields select the Host-wide list.
      return runForCaller(exec, LIST_ERRORS, () => ctx.schedule.list({
        ...(active === undefined ? {} : { active }),
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
      }).then(page => ({ ...page, items: page.items.map(modelTask) })))
    },
    presentCall: () => present('List scheduled tasks', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'schedule_view',
    description: VIEW_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
    },
    output: { schema: VIEW_OUTPUT_SCHEMA, render: renderValue },
    // Host task reads activate no target Session.
    isConcurrencySafe: () => true,
    execute(args, exec) {
      return runForCaller(exec, CALLER_ERRORS, () => ctx.schedule.view({ id: ScheduleId(args.id) })
        .then(result => 'kind' in result ? modelTask(result) : result))
    },
    presentCall: args => present('View scheduled task', 'read', args.id),
  }))

  ctx.tools.register(defineTool({
    name: 'schedule_edit',
    description: EDIT_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      action: {
        type: 'string',
        required: true,
        enum: ['update', 'delete'],
        description: 'update applies the provided fields, at least one; delete removes the task.',
      },
      title: { type: 'string', description: TITLE_HELP },
      prompt: { type: 'string', description: 'New instruction delivered at each occurrence.' },
      rrule: { type: 'string', description: 'New recurrence in the schedule_create rrule format.' },
      target: { type: 'string', enum: TARGET_CHOICES, description: 'Omit to retain the destination and its creation settings. '
        + 'Providing target replaces them; new_once reserves a different Session. New targets capture this Session\'s '
        + 'working directory and preset. Choices are the same as schedule_create.' },
      active: { type: 'boolean', description: 'false pauses the task; true resumes only if its timing has a future occurrence. '
        + 'Otherwise provide a new rrule.' },
      expectedUpdatedAt: {
        type: 'string',
        description: 'updatedAt from the latest result that returned this task; '
          + 'if the task changed after that result, the result is schedule_conflict and nothing changes.',
      },
    },
    output: { schema: EDIT_OUTPUT_SCHEMA, render: renderValue },
    execute(args, exec) {
      return runForCaller(exec, EDIT_ERRORS, (agent) => {
        const id = ScheduleId(args.id)
        const expected = args.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: args.expectedUpdatedAt }
        let request: ScheduleEditRequest
        if (args.action === 'delete') {
          if (PATCH_FIELDS.some(field => args[field] !== undefined)) {
            throw new ScheduleInputError('invalid_selector', 'delete accepts only id, action, and expectedUpdatedAt.')
          }
          request = { id, action: 'delete', ...expected }
        } else {
          const patch = {
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
            ...(args.rrule === undefined ? {} : { timing: { kind: 'rrule' as const, rrule: args.rrule } }),
            ...(args.target === undefined ? {} : { target: targetFor(agent, args.target) }),
            ...(args.active === undefined ? {} : { active: args.active }),
          }
          if (Object.keys(patch).length === 0) {
            throw new ScheduleInputError('invalid_selector', 'update requires at least one of title, prompt, rrule, target, or active.')
          }
          request = { id, action: 'update', patch, ...expected }
        }
        // The consent ask this call passed names the delivery the edit arms, so the person answered for that
        // delivery: the edit re-captures the baseline the ask named.
        return ctx.schedule.edit(request, agent.session.id, exec.signal, approvalOf(exec))
          .then(result => 'kind' in result ? modelTask(result) : result)
      })
    },
    presentCall: args => present(args.action === 'delete' ? 'Delete scheduled task' : 'Edit scheduled task', 'other', args.id),
  }))
}
