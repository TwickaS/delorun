/**
 * The `delo-update-gate` row of `@delo/bundle-local`: the `deloTurnGate` service, through which `delorun`'s Host
 * refuses every new model turn while an update or a stop waits for running chats (contract C19's `waiting` phase), so
 * the wait ends once the turns already running end.
 *
 * The plugin listens on upstream's `agent/pre-step` waterfall and refuses step 1 of a turn while any attached source
 * reports held, by throwing {@link UpdatePendingError}: the loop ends that turn as `error` with the error's message,
 * which the studio shows on the turn, and the claimed message is not sent. A later step of a turn that was already
 * running is let through. Nothing in this package holds the gate: the CLI attaches its chat gate's held state with
 * {@link UpdateTurnGate.attach}.
 *
 * With {@link Config.holdUntilChecked} on, step 1 of every turn also waits until the CLI calls
 * {@link UpdateTurnGate.release}, which it does once its check of the booted Host's rows and services passes (contract
 * C19, "Host invariants"), so no turn starts before that check. A turn still waiting when the Host stops is refused with
 * {@link UpdatePendingError}. The wait is bounded by {@link Config.checkWaitSeconds}: a turn still waiting after that
 * long ends as `error` with {@link StartCheckPendingError}, whose message says that the start's check did not finish
 * and to start Delo with `delorun start`, so a Host booted without the CLI's release, or a start whose check never
 * completes, refuses turns with a message instead of leaving them silent. The first turn that waits is logged once at
 * warn on the Host log. The hold never lets a turn through without a release.
 *
 * Every registration sits behind the C16 switch `update_turn_refusal` ({@link Config.enabled}), off by default: off,
 * the plugin provides no service and registers no listener, which is the parity value.
 *
 * @module @delo/bundle-local/update-gate
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Delo's update gate for new turns; present while the `delo-update-gate` row is mounted with its switch on. */
    deloTurnGate: UpdateTurnGate
  }
}

/** The plugin's name in the loader's diagnostics. */
export const name = 'delo-update-gate'

/** The plugin's configuration. */
export interface Config {
  /**
   * C16 switch `update_turn_refusal`: whether the plugin provides the `deloTurnGate` service and refuses new turns
   * while an attached source is held. Off, the parity value and the default, it mounts nothing and every turn starts
   * as upstream starts it. Delo's composition turns it on.
   */
  readonly enabled: boolean
  /**
   * Whether step 1 of every turn waits for {@link UpdateTurnGate.release} before it runs. Off by default, the parity
   * value; Delo's composition turns it on, and `delorun` releases the gate once the booted Host passes its check.
   */
  readonly holdUntilChecked: boolean
  /**
   * With {@link Config.holdUntilChecked} on, the seconds a turn's first step waits for {@link UpdateTurnGate.release}
   * before the turn ends with {@link StartCheckPendingError}, a whole number from 1 to 3600. The start's check takes seconds, so the
   * default only ends a wait that has no release coming.
   */
  readonly checkWaitSeconds: number
}

/** Validated configuration. The default is the parity value. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  holdUntilChecked: z.boolean().default(false),
  checkWaitSeconds: z.number().step(1).min(1).max(3600).default(60),
})

/** The code of the refusal, contract C19's `UPDATE_PENDING`. */
export const UPDATE_PENDING = 'UPDATE_PENDING'

/** What the person reads on a refused turn. */
export const UPDATE_PENDING_MESSAGE = `${UPDATE_PENDING}: Delo is updating or stopping and starts no new turn until it is back. This message was not sent; send it again once Delo is back.`

/** The refusal of a new turn while the gate is held. */
export class UpdatePendingError extends Error {
  /** Contract C19's code for a turn refused while an update waits for running chats. */
  readonly code = UPDATE_PENDING

  constructor() {
    super(UPDATE_PENDING_MESSAGE)
    this.name = 'UpdatePendingError'
  }
}

/** The code of the refusal of a turn whose wait for the start's check ran out. */
export const START_CHECK_PENDING = 'START_CHECK_PENDING'

/**
 * Message of the refusal of a turn whose wait for the start's check ran out.
 * @param seconds - the wait that ran out.
 * @returns what the person reads on the refused turn.
 */
export function startCheckPendingMessage(seconds: number): string {
  return `${START_CHECK_PENDING}: Delo's start check did not finish within ${seconds} seconds, so this turn was refused and the message was not sent. Start Delo with \`delorun start\` and send it again; \`delorun status\` and \`delorun logs\` say what the start is doing.`
}

/** The refusal of a turn that waited longer than {@link Config.checkWaitSeconds} for the start's check. */
export class StartCheckPendingError extends Error {
  /** The code of this refusal. */
  readonly code = START_CHECK_PENDING

  /** @param seconds - the wait that ran out. */
  constructor(seconds: number) {
    super(startCheckPendingMessage(seconds))
    this.name = 'StartCheckPendingError'
  }
}

/** The service through which the CLI holds new turns back. */
export interface UpdateTurnGate {
  /**
   * Add a source of the held state: while any attached source answers true, step 1 of every turn is refused.
   * @param isHeld - read at each turn's first step; it must not throw.
   * @returns the disposer, which detaches the source; a second call does nothing.
   */
  attach(isHeld: () => boolean): () => void
  /** Whether an attached source answers true now. */
  readonly held: boolean
  /**
   * Let the turns that wait for the start's check go on, and every later turn start without waiting; a second call does
   * nothing. Without {@link Config.holdUntilChecked} no turn waits, and this does nothing.
   */
  release(): void
}

/** The `deloTurnGate` service. */
export class UpdateTurnGateService extends Service implements UpdateTurnGate {
  private readonly sources = new Set<() => boolean>()
  /** Settles `true` on {@link release} and `false` when the plugin stops first. */
  private readonly checked = Promise.withResolvers<boolean>()
  private open: boolean
  private readonly checkWaitSeconds: number
  private warned = false

  /**
   * Provide the service and refuse step 1 of every turn while it is held; with the start hold on, step 1 first waits
   * for {@link release} for at most {@link Config.checkWaitSeconds}. The listener runs before every other `agent/pre-step` listener, so a refused turn spends no
   * later listener's work.
   * @param ctx - the plugin context.
   * @param config - the switches.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'deloTurnGate')
    this.open = !config.holdUntilChecked
    this.checkWaitSeconds = config.checkWaitSeconds
    ctx.on('agent/pre-step', async ({ step, signal }, next) => {
      if (step === 1 && !this.open) await this.waitForCheck(signal)
      if (step === 1 && this.held) throw new UpdatePendingError()
      return next()
    }, { prepend: true })
    ctx.effect(() => () => { this.checked.resolve(false) })
  }

  /** @inheritdoc */
  release(): void {
    this.open = true
    this.checked.resolve(true)
  }

  /**
   * Wait until the start's check passes.
   * @param signal - the turn's abort signal.
   * @throws {UpdatePendingError} when the plugin stops before the check passes.
   * @throws {StartCheckPendingError} when the check has not passed after {@link Config.checkWaitSeconds}.
   * @throws the signal's reason when the turn is aborted while it waits.
   */
  private async waitForCheck(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const waiting = Promise.withResolvers<boolean>()
    const onAbort = (): void => { waiting.reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    void this.checked.promise.then(waiting.resolve)
    const timer = setTimeout(() => { waiting.reject(new StartCheckPendingError(this.checkWaitSeconds)) }, this.checkWaitSeconds * 1000)
    if (!this.warned) {
      this.warned = true
      this.ctx.logger.warn(`${name}: a turn waits for the start's check; it is refused after ${this.checkWaitSeconds} seconds if \`delorun\` has not released the gate`)
    }
    try {
      if (!await waiting.promise) throw new UpdatePendingError()
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** @inheritdoc */
  attach(isHeld: () => boolean): () => void {
    const source = (): boolean => isHeld()
    this.sources.add(source)
    return () => { this.sources.delete(source) }
  }

  /** @inheritdoc */
  get held(): boolean {
    for (const source of this.sources) if (source()) return true
    return false
  }
}

/**
 * With the `update_turn_refusal` switch on, mount the `deloTurnGate` service. Off, mount nothing, so no turn is ever
 * refused, which is what the parity composition asserts.
 * @param ctx - the plugin context.
 * @param config - the switch, defaulted by the schema above.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  new UpdateTurnGateService(ctx, config)
}
