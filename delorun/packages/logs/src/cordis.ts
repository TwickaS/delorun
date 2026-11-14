/**
 * The Cordis logger exporter: every Cordis logger message of a surface's process becomes a record on its log, and a
 * record written while an agent drives a turn carries upstream's session id and turn number, read from the agent
 * registry's initiator at the time of the write. No session-log event is changed or added.
 *
 * @module @delorun/logs/cordis
 */
import { Logger, type Context, type Exporter, type Message } from '@deepseek-ai/cordis'
// Type-only: `ctx.agents`, the agent registry.
import type {} from '@deepseek-ai/dsh-agent'
import type { LogLevel, SecretSink } from '@delorun/contract-operational-logs'
import type { LogKeys } from './record.ts'
import { LEVEL_RANK, type SurfaceLog } from './writer.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The home process's secret registry (C20, "Redaction", step 1); absent where no log redactor runs, such as in a plugin's own specs. */
    delorunSecrets?: SecretSink
  }
}

/**
 * The keys of the agent driving the code running now: its session id, and the turn number while a turn is open.
 * @param ctx - a context where upstream's agent registry may be present.
 * @returns the keys, or `undefined` outside an agent's driver chain or without an agent registry.
 */
export function agentKeys(ctx: Context): LogKeys | undefined {
  const agents = ctx.get('agents')
  if (agents === undefined) return undefined
  let agent
  try {
    agent = agents.currentInitiator()
  } catch (_error: unknown) {
    // The registry throws once disposed; a record written during teardown then carries no keys.
    return undefined
  }
  if (agent === undefined) return undefined
  const boundary = agents.turnBoundaryOf(agent.session)
  return {
    sessionId: agent.session.id,
    ...boundary.openTurnStartSeq === null ? {} : { turn: boundary.lastTurn },
  }
}

/**
 * Format a Cordis message after step 2 of the redactor: each object argument becomes its key-redacted copy, so no
 * secret-named field reaches the text, and lines are never shortened before redaction.
 */
function format(log: SurfaceLog, message: Message): { msg: string; error?: Error } {
  const [first, ...rest] = message.args
  if (message.args.length === 1 && first instanceof Error) return { msg: `${first.name}: ${first.message}`, error: first }
  const args = message.args.map(arg => (typeof arg === 'object' && arg !== null && !(arg instanceof Error) ? log.redactor.fields(arg) : arg))
  const formatter: Exporter = { colors: false, maxLength: Number.POSITIVE_INFINITY, export: () => {} }
  const msg = Logger.format(formatter, { ...message, args })
  const error = [first, ...rest].find(arg => arg instanceof Error)
  return error instanceof Error ? { msg, error } : { msg }
}

/**
 * Whether a Cordis logger name belongs to Delorun: `delorun`, a name beginning `delorun-`, or a `@delorun/` package name. Every
 * other logger belongs to upstream or to a plugin Delorun does not own.
 * @param name - the Cordis logger name.
 * @returns whether Delorun owns the logger.
 */
export function isDelorunLogger(name: string): boolean {
  return name === 'delorun' || name.startsWith('delorun-') || name.startsWith('@delorun/')
}

const TYPE_LEVEL: Readonly<Record<Message['type'], LogLevel>> = { error: 'error', warn: 'warn', info: 'info', debug: 'debug' }

/**
 * Write a context's Cordis logger messages to a surface's log, and key records by the turn an agent is driving.
 * A message from a logger Delorun owns ({@link isDelorunLogger}) is `source: "delorun"`; a message from any other logger is
 * `source: "captured"`, because upstream warnings and errors can quote chat text, which Delorun's own records never hold.
 * Both registrations are effects of `ctx` and end when it is disposed. A surface that also keeps upstream's console
 * exporter and captures its own output writes each message twice; such a surface removes one of the two.
 * @param ctx - the root context of the surface's Cordis application.
 * @param log - the surface's log.
 * @returns a disposer that removes the exporter and the key source.
 */
export function attachCordisLogs(ctx: Context, log: SurfaceLog): () => void {
  const stopKeys = ctx.effect(() => log.useKeys(() => agentKeys(ctx)), 'delorun-logs keys')
  const stopExporter = ctx.logger.exporter({
    colors: false,
    levels: { default: LEVEL_RANK[log.level] },
    export: (message) => {
      const { msg, error } = format(log, message)
      log.write({ level: TYPE_LEVEL[message.type], logger: message.name, source: isDelorunLogger(message.name) ? 'delorun' : 'captured', msg, ...error === undefined ? {} : { error } })
    },
  })
  return () => {
    void stopExporter()
    void stopKeys()
  }
}
