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
 * {@link UpdatePendingError}.
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
}

/** Validated configuration. The default is the parity value. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  holdUntilChecked: z.boolean().default(false),
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

  /**
   * Provide the service and refuse step 1 of every turn while it is held; with the start hold on, step 1 first waits
   * for {@link release}. The listener runs before every other `agent/pre-step` listener, so a refused turn spends no
   * later listener's work.
   * @param ctx - the plugin context.
   * @param config - the switches.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'deloTurnGate')
    this.open = !config.holdUntilChecked
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
   * @throws {UpdatePendingError} when the plugin stops before the check passes; the signal's reason when the turn is
   *   aborted while it waits.
   */
  private async waitForCheck(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const waiting = Promise.withResolvers<boolean>()
    const onAbort = (): void => { waiting.reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    void this.checked.promise.then(waiting.resolve)
    try {
      if (!await waiting.promise) throw new UpdatePendingError()
    } finally {
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
