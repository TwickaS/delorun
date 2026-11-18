/**
 * The page's one queue of visible effects, such as a theme change. It plays one effect at a time, each to its end and in
 * order, so two colour transitions never overlap. It holds at most {@link LIMIT} effects, the running one included; a
 * request when it is full replaces the last waiting effect, so a press never blocks. While effects wait, the running one
 * and those after it play faster, so a burst of presses settles in about two seconds.
 *
 * @module @delorun/website/home/effects
 */
import { useSyncExternalStore } from 'react'

/** The most effects the queue holds, the running one included. */
export const LIMIT = 5

/** What an effect gets while it runs. */
export interface EffectRun {
  /** How much faster than normal to play: 1 when nothing waits, more as effects queue up. */
  readonly speed: () => number
  /** Registers the effect's animation, so the queue can speed it up when more effects arrive. */
  readonly track: (animation: Animation) => void
}

/** One effect. */
export interface Effect {
  /** A short name of what it does, shown in the status readout, for example `theme → Ocean`. */
  readonly label: string
  /** What the readout shows when it has finished, for example `✓ Ocean`. */
  readonly done: string
  /** The state the effect leaves the page in, for example a look's id, so a later request can follow on from it. */
  readonly value: string
  /** Plays the effect; the promise settles when it has finished. */
  readonly run: (run: EffectRun) => Promise<void>
}

/** What the readout shows. */
export interface EffectState {
  /** The running effect's label, if one runs. */
  readonly running?: string
  /** How many effects wait behind it. */
  readonly waiting: number
  /** The last finished effect's message, until the readout returns to idle. */
  readonly done?: string
}

const IDLE: EffectState = { waiting: 0 }
let state: EffectState = IDLE
let running: Effect | undefined
const waiting: Effect[] = []
let tracked: Animation | undefined
let idleTimer: number | undefined
const listeners = new Set<() => void>()

/**
 * How fast to play while some effects wait.
 * @returns the playback rate.
 */
function speed(): number {
  return 1 + waiting.length * 0.8
}

/**
 * Publishes the queue's state to the readout.
 * @param next - the state.
 */
function publish(next: EffectState): void {
  state = next
  for (const listener of listeners) listener()
}

/** Starts the next waiting effect, or returns to idle after a moment. */
function next(): void {
  const effect = waiting.shift()
  running = effect
  tracked = undefined
  if (effect === undefined) {
    window.clearTimeout(idleTimer)
    idleTimer = window.setTimeout(() => publish(IDLE), 1600)
    return
  }
  publish({ running: effect.label, waiting: waiting.length })
  const finish = () => {
    publish({ waiting: waiting.length, done: effect.done })
    next()
  }
  effect.run({ speed, track: animation => { tracked = animation; animation.playbackRate = speed() } }).then(finish, (error: unknown) => {
    // An effect that fails still ends its turn; the page keeps working and the readout moves on.
    console.error('A page effect failed', error)
    finish()
  })
}

/**
 * Asks for an effect. It runs at once when nothing runs; otherwise it waits, or replaces the last waiting effect when
 * the queue is full.
 * @param effect - the effect.
 */
export function enqueue(effect: Effect): void {
  window.clearTimeout(idleTimer)
  if (running === undefined) {
    waiting.push(effect)
    next()
    return
  }
  if (1 + waiting.length >= LIMIT) waiting[waiting.length - 1] = effect
  else waiting.push(effect)
  if (tracked !== undefined) tracked.playbackRate = speed()
  publish({ running: running.label, waiting: waiting.length })
}

/**
 * Shows one line about something the visitor did, such as `✓ copied pnpm dlx delorun`, then returns to idle. The line
 * gives way to running effects: while one runs, or one finished a moment ago, the note is dropped, so the readout shows
 * one line at a time.
 * @param text - the line.
 */
export function note(text: string): void {
  if (running !== undefined) return
  window.clearTimeout(idleTimer)
  publish({ waiting: 0, done: text })
  idleTimer = window.setTimeout(() => publish(IDLE), 1600)
}

/**
 * The effect that will have run last: the last waiting one, or the running one.
 * @returns the effect, or undefined when the queue is empty.
 */
export function lastQueued(): Effect | undefined {
  return waiting[waiting.length - 1] ?? running
}

/**
 * The queue's state, kept current.
 * @returns the state; idle during server rendering.
 */
export function useEffects(): EffectState {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => state,
    () => IDLE,
  )
}
