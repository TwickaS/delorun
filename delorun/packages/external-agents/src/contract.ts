/**
 * The driver contract between Delorun's start gate and the program drivers for Claude Code and Codex, and the service
 * interfaces of the gate (`ctx.externalAgents`) and the account and limits store (`ctx.agentAccounts`). Its imports are
 * type-only, so every driver, the limits service, the consent and the CLI import it without loading another package.
 *
 * A driver turns one pinned program into an ordered {@link ProgramEvent} stream. It never starts a process itself: the
 * gate hands it {@link ProgramSpawn}, the only way to get one (T1).
 * @module @delorun/external-agents/contract
 */
import type {} from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessStdio } from '@deepseek-ai/dsh-subprocess'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export type { Agent, JsonValue, SessionId, SubprocessHandle, TokenUsage }

/** An external agent by upstream's provider name. */
export type ExternalAgentName = 'claude-code' | 'codex'

/** One thing the program did, in program order. */
export type ProgramEvent =
  /** Assistant text, in the order the program produced it. */
  | { readonly kind: 'text'; readonly text: string }
  /** The program's visible reasoning text. */
  | { readonly kind: 'reasoning'; readonly text: string }
  /** The program called one of its own tools; the call has already started inside the program. */
  | { readonly kind: 'tool-call'; readonly id: string; readonly name: string; readonly input: string }
  /**
   * One program assistant message ended; its tool calls, if any, now run inside the program. `usage` covers the model
   * requests not yet reported on an earlier event, so a reader sums every `usage` without counting twice.
   */
  | { readonly kind: 'message-end'; readonly usage?: TokenUsage }
  /** The program's own result for one of its tool calls. */
  | { readonly kind: 'tool-result'; readonly id: string; readonly output: string; readonly isError: boolean }
  /**
   * The program's turn ended; `failure` is present when `outcome` is `failed`. `usage` covers only what no
   * `message-end` of the turn reported.
   */
  | {
    readonly kind: 'turn-end'
    readonly outcome: 'completed' | 'interrupted' | 'failed'
    readonly usage?: TokenUsage
    readonly failure?: ProgramFailure
  }

/**
 * Why a turn or an open failed: a closed set that the seat turns into fixed sentences for the model. Only
 * `program.detail` carries the program's own words, and it goes to the person's view, never to the model.
 */
export type ProgramFailure =
  /** The program has no usable sign-in. */
  | { readonly category: 'signed-out' }
  /** A plan limit is reached; `resetsAt` is in milliseconds since the epoch when the program said. */
  | { readonly category: 'limit'; readonly resetsAt?: number }
  /** The model the person picked is not offered to this account; `offered` lists what is (EA22). */
  | { readonly category: 'model-not-offered'; readonly configured: string; readonly offered: readonly OfferedModel[] }
  /** The program's own session or thread named by `resume` is gone. */
  | { readonly category: 'resume-failed' }
  /** The gate ended the turn at the consent's time limit, `limitMs`; only the gate reports it, never a driver. */
  | { readonly category: 'time-limit'; readonly limitMs: number }
  /** Anything else; `detail` is for the person's view only. */
  | { readonly category: 'program'; readonly detail: string }

/** One model a program offers to the signed-in account. */
export interface OfferedModel {
  /** The id the program takes. */
  readonly id: string
  /** The name the program shows. */
  readonly displayName: string
  /** Whether the program uses it when none is picked. */
  readonly isDefault: boolean
}

/**
 * A rule a person allowed "for this run". Opaque to everyone but the driver that made it: the gate keeps it in memory
 * beside the seat's lease and hands it back on every open (EA21); nothing writes it to disk.
 */
export interface ProgramRunRule {
  /** The driver that made the rule and alone reads `data`. */
  readonly provider: ExternalAgentName
  /** What the rule allows, in plain words, for the person's view. */
  readonly summary: string
  /** The driver's own encoding of the rule. */
  readonly data: JsonValue
}

/** A question the program raises about one of its tool calls. */
export interface ProgramApprovalRequest {
  /** The program's id for the tool call, which the seat recorded as a `tool-call` event. */
  readonly callId: string
  /** The program's tool name. */
  readonly toolName: string
  /** Plain description of what the program wants to do, shown to the person. */
  readonly reason: string
  /** Present only when "Allow for this run" can be honoured for exactly this call. */
  readonly runRule?: ProgramRunRule
  /** Aborts when the program withdraws the question. */
  readonly signal: AbortSignal
}

/**
 * The answer to a program's question. `allow-run` is given only for a request that carried a `runRule`; the gate then
 * keeps that rule for the seat.
 */
export type ProgramApprovalAnswer = 'allow-once' | 'allow-run' | 'reject' | 'cancel'

/** A harness tool offered to the program over MCP (used from Stage 3). */
export interface ProgramHarnessTool {
  /** The tool name the program sees. */
  readonly name: string
  /** The description the program sees. */
  readonly description: string
  /** The JSON Schema of the tool's input. */
  readonly inputSchema: JsonValue
  /**
   * Run the tool for the program.
   * @param input - the program's validated-by-schema input.
   * @param signal - aborts the call.
   * @returns the tool's text output and whether it is an error.
   */
  call(input: JsonValue, signal: AbortSignal): Promise<{ readonly output: string; readonly isError: boolean }>
}

/** What a driver asks the gate to start: the program and its pipes. The gate supplies everything else. */
export interface ProgramSpawnRequest {
  /** Executable and arguments; `argv[0]` is the program, an absolute path. Never shell-interpreted. */
  readonly argv: readonly string[]
  /**
   * Entries merged onto `@deepseek-ai/dsh-subprocess`'s scrubbed parent environment; `undefined` removes an entry. A
   * driver adds no entry that names a credential. The gate then removes `NODE_OPTIONS` and every `DELORUN_*` name
   * whatever the overlay says.
   */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Per-stream dispositions; drivers use pipes. */
  readonly stdio: SubprocessStdio
}

/**
 * The only way a driver gets a process. The gate adds the working folder, its grace period and its own abort signal,
 * records the process for teardown, and returns the managed handle. Throws when the gate refuses, for example after
 * the seat's session ended.
 */
export type ProgramSpawn = (request: ProgramSpawnRequest) => SubprocessHandle

/** What an agent may do on its own (EA34), from the most to the least confined. */
export type AgentLevel = 'careful' | 'standard' | 'own' | 'unrestricted'

/** What the gate hands a driver to open or resume one program session for one seat child. */
export interface ProgramOpenRequest {
  /** The seat child's harness Session id. */
  readonly sessionId: SessionId
  /** The run folder; the gate already passes it to every spawn. */
  readonly cwd: string
  /** The program's own session or thread id to resume; absent opens a fresh one. */
  readonly resume?: string
  /** A model the person picked (EA22); absent means the program's default. */
  readonly model?: string
  /** Rules the person allowed for this run, re-applied on open (EA21). */
  readonly runRules: readonly ProgramRunRule[]
  /** Harness tools offered to the program over MCP; empty until Stage 3. */
  readonly harnessTools: readonly ProgramHarnessTool[]
  /**
   * The level this seat runs at (EA34): the consent's level for the agent, or the one saved on the consent row while
   * the consent is off.
   */
  readonly level: AgentLevel
  /**
   * Whether any other live program of the gate, of any agent, runs in this program's folder, in a folder inside it or
   * in one that contains it. Read when asked, so a clean-up sees the programs alive then.
   * @returns true when another live program shares the folder.
   */
  sharesFolder(): boolean
  /** The only way to get a process. */
  readonly spawn: ProgramSpawn
  /**
   * Ask the person about one of the program's tool calls.
   * @param request - the program's question.
   * @returns the person's answer; `cancel` when the turn ended first.
   */
  onApproval(request: ProgramApprovalRequest): Promise<ProgramApprovalAnswer>
  /**
   * Report plan and limit figures the program sent during the run.
   * @param observation - the figures, with `source: 'run'`.
   */
  onLimits(observation: AccountObservation): void
  /** The gate ends the session through this; the driver then closes its process. */
  readonly signal: AbortSignal
}

/**
 * How {@link ProgramSession.interrupt} ended the turn. `closed` means the driver had to close the program's process to
 * stop it (Codex with a command still open, L32): the session is finished, and the seat resumes the program's own
 * session on its next message.
 */
export type ProgramInterruptOutcome = 'interrupted' | 'closed'

/** One open program session. */
export interface ProgramSession {
  /** The program's own session or thread id, which `resume` takes. */
  readonly programSessionId: string
  /** Whether a program turn is running now. */
  readonly turnRunning: boolean
  /**
   * Deliver the person's or the parent's text.
   * @param text - the input text.
   * @param mode - `start` begins a turn; `steer` joins the running turn at its next tool boundary.
   */
  send(text: string, mode: 'start' | 'steer'): Promise<void>
  /**
   * End the running turn. The turn's `turn-end` event still arrives through {@link next}.
   * @returns whether the session stays open (`interrupted`) or its process was closed (`closed`).
   */
  interrupt(): Promise<ProgramInterruptOutcome>
  /**
   * Take the next event, waiting for one.
   * @param signal - aborts the wait.
   * @returns the next event in program order.
   */
  next(signal: AbortSignal): Promise<ProgramEvent>
  /** End the process; the program's own state stays where the program keeps it. Idempotent. */
  close(): Promise<void>
}

/** One limit window as a program reports it. */
export interface LimitWindow {
  /**
   * The window, as the drivers name it: Claude Code's `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`,
   * `seven_day_overage_included`, `overage` or `unknown`; Codex's `five_hour`, `seven_day` or `window_<minutes>m`.
   * `windowTitle` in `./accounts/wire.ts` names each.
   */
  readonly kind: string
  /** Share of the window used, 0 to 100, when the program says. */
  readonly usedPercent?: number
  /** When the window resets, in milliseconds since the epoch, when the program says. */
  readonly resetsAt?: number
  /** Whether the program still allows use in this window. */
  readonly status: 'allowed' | 'near' | 'reached' | 'unknown'
}

/** What a limits check or a run reports. Never an email, organisation, account id or token. */
export interface AccountObservation {
  /** The agent observed. */
  readonly provider: ExternalAgentName
  /** Whether the program has a usable sign-in. */
  readonly signedIn: 'yes' | 'no' | 'unknown'
  /** The plan name the program reports, such as Claude's `subscriptionType` or Codex's `planType`. */
  readonly plan?: string
  /** The limit windows seen. */
  readonly windows: readonly LimitWindow[]
  /** The models the program offers (Codex `model/list`). */
  readonly offeredModels?: readonly OfferedModel[]
  /** Whether a run or a limits check saw it. */
  readonly source: 'run' | 'probe'
}

/** Opens program sessions for one agent and checks its account. Registered by the agent's driver plugin. */
export interface ExternalAgentDriver {
  /** The agent this driver runs. */
  readonly provider: ExternalAgentName
  /**
   * Open or resume a program session.
   * @param request - the seat, folder, resume id, rules, spawn and callbacks from the gate.
   * @returns the open session.
   * @throws {@link ProgramOpenError} when the program cannot open the session.
   */
  open(request: ProgramOpenRequest): Promise<ProgramSession>
  /**
   * Check the sign-in, plan and limits with a short-lived program that runs no task.
   * @param request - the gate's spawn, an empty Delorun-owned folder and the check's abort signal.
   * @returns the figures, with `source: 'probe'`.
   */
  probe(request: { readonly spawn: ProgramSpawn; readonly cwd: string; readonly signal: AbortSignal }): Promise<AccountObservation>
}

/** A driver's typed failure to open a session: the seat words it from {@link ProgramFailure}. */
export class ProgramOpenError extends Error {
  /** Why the open failed. */
  readonly failure: ProgramFailure

  /**
   * @param failure - why the open failed.
   * @param options - the underlying error, for the person's view and the logs.
   */
  constructor(failure: ProgramFailure, options?: ErrorOptions) {
    super(`The external agent could not open a session: ${failure.category}`, options)
    this.name = 'ProgramOpenError'
    this.failure = failure
  }
}

/** A request to start a seat's program through the gate. */
export interface SeatStartRequest {
  /** A program for a live agent seat. */
  readonly purpose: 'seat'
  /** The agent to run. */
  readonly provider: ExternalAgentName
  /** The Session that created the seat; its root chat is where consent is asked. */
  readonly creator: SessionId
  /** The seat child's Session; the gate keeps at most one program per child. */
  readonly child: SessionId
  /** The run folder. */
  readonly cwd: string
  /** The program's own session or thread id to resume. */
  readonly resume?: string
  /** A model the person picked. */
  readonly model?: string
  /** Harness tools offered to the program. */
  readonly harnessTools: readonly ProgramHarnessTool[]
  /**
   * Ask the person about one of the program's tool calls; the gate records `allow-run` answers itself.
   * @param request - the program's question.
   * @returns the person's answer.
   */
  onApproval(request: ProgramApprovalRequest): Promise<ProgramApprovalAnswer>
  /** Aborts the start; after the start, aborting it ends the program. */
  readonly signal: AbortSignal
}

/** A seat the gate holds a program for: what the seat relay, route and executor recognise a seat by. */
export interface SeatRecord {
  /** The seat child's Session. */
  readonly child: SessionId
  /** The chat at the top of the seat's tree. */
  readonly root: SessionId
  /** The agent the seat runs. */
  readonly provider: ExternalAgentName
}

/** Why the gate refused a start: a closed set the caller turns into fixed sentences. */
export type GateRefusal =
  /** No driver is registered for the agent: its pack is not added. */
  | { readonly category: 'not-installed' }
  /** Consent refused; `reason` is the consent service's sentence for the model. */
  | { readonly category: 'consent'; readonly reason: string }
  /** A plan limit is reached until `resetsAt`, in milliseconds since the epoch, for the window `window`. */
  | { readonly category: 'limit'; readonly window: string; readonly resetsAt: number }
  /** `maxLivePrograms` programs already run; `busy` names the agents running them. */
  | { readonly category: 'capacity'; readonly busy: readonly ExternalAgentName[] }
  /** The gate already holds a program for this seat child. */
  | { readonly category: 'seat-running' }

/** The gate's typed refusal of a start. */
export class GateRefusedError extends Error {
  /** Why the gate refused. */
  readonly refusal: GateRefusal

  /** @param refusal - why the gate refused. */
  constructor(refusal: GateRefusal) {
    super(`The external agent was not started: ${refusal.category}`)
    this.name = 'GateRefusedError'
    this.refusal = refusal
  }
}

/** The gate: the only code that starts an external agent's program (T1). Service `ctx.externalAgents`. */
export interface ExternalAgentsGate {
  /**
   * Register the driver for one agent while its pack is present; a registration effect.
   * @param driver - the driver.
   * @returns the disposer, which ends every program of that driver.
   */
  registerDriver(driver: ExternalAgentDriver): () => void
  /**
   * Start a seat's program: consent, limits, capacity, then the driver's open with the gate's spawn.
   * @param request - the seat and its callbacks.
   * @returns the open program session, with the reason it was allowed.
   * @throws {@link GateRefusedError} when the gate refuses; {@link ProgramOpenError} when the program cannot open.
   */
  start(request: SeatStartRequest): Promise<SeatSession>
  /**
   * Run a limits check through the driver's probe in a folder the gate picks, counted against `maxLivePrograms`. It
   * takes no folder, no child and no input.
   * @param provider - the agent to check.
   * @param signal - aborts the check.
   * @returns the figures the program reported.
   * @throws {@link GateRefusedError} when the gate refuses.
   */
  probe(provider: ExternalAgentName, signal: AbortSignal): Promise<AccountObservation>
  /**
   * The fixed refusal of a start while the agent's plan limit is reached with a reset time in the future, when the
   * C16 switch `external_agent_limit_refusal` is on; stale figures never refuse. The consent's one-shot review asks it
   * too.
   * @param provider - the agent.
   * @returns the sentence for the model, or undefined when nothing refuses.
   */
  limitRefusal(provider: ExternalAgentName): Promise<string | undefined>
  /**
   * Hear each driver registration, for the limits check that follows adding a pack; a registration effect.
   * @param listener - called with the agent whose driver registered.
   * @returns the disposer.
   */
  onDriverRegistered(listener: (provider: ExternalAgentName) => void): () => void
  /**
   * Whether an agent's driver is registered, that is whether its pack is added and running.
   * @param provider - the agent.
   * @returns true while a driver is registered.
   */
  hasDriver(provider: ExternalAgentName): boolean
  /**
   * The seat the gate holds a program or a lease for. A seat is recognised by this registry, never by an approval
   * policy value.
   * @param child - a Session id.
   * @returns the seat, or undefined when the Session is not a seat.
   */
  seat(child: SessionId): SeatRecord | undefined
}

/** One limit window as stored, with when and how it was seen. */
export interface RecordedLimitWindow extends LimitWindow {
  /** When the figures were seen, in milliseconds since the epoch. */
  readonly seenAt: number
  /** Whether a run or a limits check saw them. */
  readonly source: 'run' | 'probe'
}

/** What the store knows about one agent's account. Never an email, organisation, account id or token. */
export interface AccountRecord {
  /** The agent. */
  readonly provider: ExternalAgentName
  /** Whether the program has a usable sign-in; `unknown` until the first check or run. */
  readonly signedIn: 'yes' | 'no' | 'unknown'
  /** The plan name, when known. */
  readonly plan?: string
  /** The limit windows, one per kind, each with its own `seenAt`. */
  readonly windows: readonly RecordedLimitWindow[]
  /** The models the program offers, when known. */
  readonly offeredModels?: readonly OfferedModel[]
  /** Whether a driver for the agent is registered, that is whether its pack is added. */
  readonly installed: boolean
  /** When a limits check last answered, in milliseconds since the epoch. */
  readonly checkedAt?: number
  /** When a limits check last failed, in milliseconds since the epoch; a failure counts towards the interval between checks. */
  readonly checkFailedAt?: number
  /** When `delorun agents login` finished with no Host running and left a check for the Host's next start, in milliseconds since the epoch. */
  readonly checkRequestedAt?: number
}

/** A limit that refuses a start now. */
export interface ReachedLimit {
  /** The agent. */
  readonly provider: ExternalAgentName
  /** The window's kind. */
  readonly window: string
  /** When the window resets, in milliseconds since the epoch; always after the time asked about. */
  readonly resetsAt: number
}

/** How a refresh ended. */
export type AccountRefreshOutcome =
  /** The check answered and the record holds its figures. */
  | { readonly kind: 'checked' }
  /** A check ran too recently; the next may run at `nextAt`, in milliseconds since the epoch. */
  | { readonly kind: 'throttled'; readonly nextAt: number }
  /** No driver for the agent is registered. */
  | { readonly kind: 'not-installed' }
  /** The check ran and failed, with the reason the person reads. */
  | { readonly kind: 'failed'; readonly problem: string }
  /** The gate refused the check, for example at its cap, with the refusal the person reads. */
  | { readonly kind: 'refused'; readonly problem: string }
  /** The reason is not in the gate row's `probeTriggers` list, so no check runs. */
  | { readonly kind: 'turned-off' }

/** The explicit act about one agent that asked for a check; nothing else starts one. */
export type AccountRefreshReason = 'pack-added' | 'signed-in' | 'check-now'

/** The account and limits store. Service `ctx.agentAccounts`, provided by this package's accounts module. */
export interface AgentAccounts {
  /**
   * Read what the store knows about one agent.
   * @param provider - the agent.
   * @returns the record; `signedIn: 'unknown'` and no windows when nothing is known or the store cannot be read.
   */
  read(provider: ExternalAgentName): Promise<AccountRecord>
  /**
   * Read what the store knows about every agent.
   * @returns one record per agent, and the time they were read at, in milliseconds since the epoch.
   */
  readAll(): Promise<{ readonly accounts: readonly AccountRecord[]; readonly now: number }>
  /**
   * Merge figures from a run or a check into the store: windows by kind, the newer `seenAt` wins.
   * @param observation - the figures.
   */
  observe(observation: AccountObservation): void
  /**
   * Check one agent's account through the gate's `probe`, at most once per `probeMinIntervalMinutes` and one at a time.
   * @param provider - the agent.
   * @param reason - why the check is asked for.
   * @returns how the check ended, the record afterwards, and the time it ended at, in milliseconds since the epoch.
   */
  refresh(provider: ExternalAgentName, reason: AccountRefreshReason): Promise<{ readonly outcome: AccountRefreshOutcome; readonly record: AccountRecord; readonly now: number }>
  /**
   * The limit that refuses a start at `now`, if any. Pure: stale figures (a reset time not after `now`) never refuse.
   * @param record - the agent's record.
   * @param now - the time asked about, in milliseconds since the epoch.
   * @returns the reached window with the latest reset time, or undefined.
   */
  reachedLimit(record: AccountRecord, now: number): ReachedLimit | undefined
}

/** The consent row the gate reads to tell "consent switched off" from "consent missing" (review D6). */
export const DELEGATION_CONSENT_ROW_ID = 'delorun-delegation-consent'

/**
 * When a seat review runs: at hand-off (the first program for a new seat), at resume (a program for a seat whose
 * earlier program ended), or at the start of each seat turn. A turn review never asks anyone.
 */
export type SeatReviewPhase = 'hand-off' | 'resume' | 'turn'

/** The facts of one seat review. */
export interface SeatReview {
  /** The agent the seat runs. */
  readonly provider: ExternalAgentName
  /** The Agent that created the seat. */
  readonly creator: Agent
  /** The chat at the top of the seat's tree, whose workspace the lease and grant are keyed to. */
  readonly root: Agent
  /** The seat child. */
  readonly child: Agent
  /** The run folder. */
  readonly cwd: string
  /** The seat's label, named on the card. */
  readonly label?: string
  /** When the review runs. */
  readonly phase: SeatReviewPhase
  /** Aborts a pending card. */
  readonly signal: AbortSignal
}

/**
 * Why a seat review allowed the seat: a lease that still holds, a workspace grant, the person's answer to the card,
 * or the root chat's Full access (approval policy `never`), which starts a seat with no card and no grant.
 */
export type SeatAllowReason = 'lease' | 'granted' | 'asked' | 'full-access'

/** A seat's program session as the gate hands it out. */
export interface SeatSession extends ProgramSession {
  /** Why the start was allowed, which the hand-off line shows; `consent-off` when the consent row's saved `enabled` is false. */
  readonly allowedBy: SeatAllowReason | 'consent-off'
}

/** A seat review's answer; `timeoutMs` bounds one seat turn, and `why` names the reason the hand-off line shows. */
export type SeatVerdict =
  | { readonly kind: 'allow'; readonly timeoutMs: number; readonly why: SeatAllowReason }
  | { readonly kind: 'refuse'; readonly reason: string }

/** One approval of a seat, kept in memory only until an end event (T4, review D11). */
export interface SeatLease {
  /** The seat child. */
  readonly child: SessionId
  /** The root chat when the seat was allowed. */
  readonly root: SessionId
  /** The workspace key when the seat was allowed. */
  readonly workspace: string
  /** The run folder when the seat was allowed. */
  readonly cwd: string
  /** The agent allowed. */
  readonly provider: ExternalAgentName
  /** Whether the workspace was in Delorun's workspace list when allowed; the lease ends once such a workspace is removed. */
  readonly workspaceListed: boolean
  /** When the person or a grant allowed it, in milliseconds since the epoch. */
  readonly grantedAt: number
  /** Why it was allowed; a `full-access` lease ends once the root chat leaves Full access or its switch turns off. */
  readonly why: Exclude<SeatAllowReason, 'lease'>
}

/** Why a lease ended. */
export type SeatLeaseEnd =
  /** The child, the root or an ancestor of the child was archived. */
  | 'archived'
  /** The person revoked the lease. */
  | 'revoked'
  /** The workspace grant for the agent was revoked. */
  | 'grant-revoked'
  /** The consent switch turned off or the consent's service stopped. */
  | 'consent-off'
  /** A review refused, or the root, workspace, run folder or agent no longer match the lease, or its workspace was removed. */
  | 'refused'

/**
 * The seat side of Delorun's consent service (`ctx.delegationConsent`): the gate finds it by the presence of
 * `reviewSeat` and refuses every seat start without it (T3).
 */
export interface SeatConsent {
  /**
   * Review one seat: the shared ordered rules, then the lease, the grant, and at hand-off or resume a card.
   * @param review - the facts of the review.
   * @returns the verdict; a refusal ends the child's lease.
   */
  reviewSeat(review: SeatReview): Promise<SeatVerdict>
  /**
   * The child's lease.
   * @param child - the seat child.
   * @returns the lease, or undefined.
   */
  leaseOf(child: SessionId): SeatLease | undefined
  /**
   * The level the person set for an agent, read at each seat start.
   * @param provider - the agent.
   * @returns the level.
   */
  permissionLevel(provider: string): AgentLevel
  /**
   * End the child's lease and its run rules.
   * @param child - the seat child.
   * @param reason - why.
   */
  endLease(child: SessionId, reason: SeatLeaseEnd): void
  /**
   * Hear every lease end, so the gate stops that child's program; a registration effect.
   * @param listener - called with the ended lease and why.
   * @returns the disposer.
   */
  onLeaseEnded(listener: (lease: SeatLease, reason: SeatLeaseEnd) => void): () => void
  /**
   * The rules the person allowed "for this run" for the child.
   * @param child - the seat child.
   * @returns the rules, oldest first; none without a lease.
   */
  runRules(child: SessionId): readonly ProgramRunRule[]
  /**
   * Keep one "for this run" rule beside the child's lease, until the lease ends (review D12).
   * @param child - the seat child.
   * @param rule - the rule.
   * @returns false, keeping nothing, when the child has no lease.
   */
  addRunRule(child: SessionId, rule: ProgramRunRule): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The start gate for external agents' programs, provided by `@delorun/external-agents`. */
    externalAgents: ExternalAgentsGate
    /** The account and limits store of external agents, provided by `@delorun/external-agents`. */
    agentAccounts: AgentAccounts
  }
}
