/**
 * The replica's player: which chapter shows, how far into it, and whether it plays. It plays only while the drawn
 * studio is ready, the frame is on screen, the tab is visible and the visitor has not paused it; it moves on to the next
 * chapter by itself and stops after the last. Under reduced motion it never plays: it opens on the session's resting
 * chapter, each chapter shows as its last state, a still, and the visitor moves between chapters with the rail. A press in the script is handed to the drawn
 * studio once, when the timeline reaches it.
 * @module @delorun/website/replica/player
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { chapterLength, nextChange, stateAt, type ChapterFile, type PressTarget, type StudioState } from './model.ts'

/** The player's options. */
export interface PlayerOptions {
  readonly file: ChapterFile
  /** Whether the drawn studio has loaded and drawn its fixture. */
  readonly ready: boolean
  /** The element whose presence on screen lets the player run. */
  readonly frame: RefObject<Element | null>
  /** Shows a press on a control and presses it. */
  readonly press: (target: PressTarget) => Promise<boolean>
}

/** What the player shows and what the visitor can do with it. */
export interface Player {
  /** The chapter's index. */
  readonly chapter: number
  readonly state: StudioState
  /** Changes whenever a chapter starts, from its beginning or by a choice on the rail. */
  readonly epoch: number
  /** Whether the timeline is moving now. */
  readonly playing: boolean
  /** Whether the visitor paused it. */
  readonly paused: boolean
  /** Whether the last chapter has finished. */
  readonly ended: boolean
  /** Whether reduced motion is asked for, so chapters show as stills. */
  readonly reduced: boolean
  /** Shows a chapter from its beginning. */
  readonly select: (chapter: number) => void
  /** Pauses, plays again, or after the last chapter starts from the first. */
  readonly toggle: () => void
}

const REDUCED = '(prefers-reduced-motion: reduce)'

/**
 * Whether the visitor asks for reduced motion.
 * @returns the preference; false on the server.
 */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = matchMedia(REDUCED)
      query.addEventListener('change', listener)
      return () => { query.removeEventListener('change', listener) }
    },
    () => matchMedia(REDUCED).matches,
    () => false,
  )
}

/**
 * Whether an element is at least partly on screen and the tab is visible.
 * @param frame - the element.
 * @returns the visibility; false until measured.
 */
function useOnScreen(frame: RefObject<Element | null>): boolean {
  const [intersecting, setIntersecting] = useState(false)
  const [shown, setShown] = useState(true)
  useEffect(() => {
    const element = frame.current
    if (element === null) return
    const observer = new IntersectionObserver(entries => { setIntersecting(entries.some(entry => entry.isIntersecting)) }, { threshold: 0.25 })
    observer.observe(element)
    const visibility = () => { setShown(document.visibilityState === 'visible') }
    visibility()
    document.addEventListener('visibilitychange', visibility)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [frame])
  return intersecting && shown
}

/**
 * Play a session's chapters.
 * @param options - see {@link PlayerOptions}.
 * @returns the player.
 */
export function usePlayer({ file, ready, frame, press }: PlayerOptions): Player {
  const reduced = useReducedMotion()
  const onScreen = useOnScreen(frame)
  // A replay that does not play opens on its resting chapter, the one its still shows.
  const [chapter, setChapter] = useState(() => reduced ? file.resting : 0)
  const [at, setAt] = useState(0)
  const [epoch, setEpoch] = useState(0)
  const [paused, setPaused] = useState(false)
  const [ended, setEnded] = useState(false)
  const playing = ready && onScreen && !paused && !ended && !reduced
  const shownAt = reduced ? Number.POSITIVE_INFINITY : at
  const { state, presses } = useMemo(() => stateAt(file, chapter, shownAt), [file, chapter, shownAt])

  useEffect(() => {
    if (!playing) return
    const current = file.chapters[chapter]
    if (current === undefined) return
    const end = chapterLength(current)
    const next = Math.min(nextChange(current, at) ?? end, end)
    const timer = setTimeout(() => {
      if (next < end) { setAt(next); return }
      if (chapter + 1 < file.chapters.length) {
        setChapter(chapter + 1)
        setAt(0)
        setEpoch(value => value + 1)
      } else {
        setAt(end)
        setEnded(true)
      }
    }, Math.max(0, next - at))
    return () => { clearTimeout(timer) }
  }, [playing, file, chapter, at])

  // Each press of a chapter run is handed over once, in order, after the drawn studio has drawn the state before it. A
  // still under reduced motion already shows the chapter's last state, so it presses nothing.
  const pressed = useRef({ epoch: -1, count: 0, queue: Promise.resolve() })
  useEffect(() => {
    if (!ready || reduced) return
    const record = pressed.current
    if (record.epoch !== epoch) {
      record.epoch = epoch
      record.count = 0
    }
    const due = presses.slice(record.count)
    record.count = presses.length
    for (const reached of due) {
      record.queue = record.queue.then(() => new Promise(requestAnimationFrame)).then(() => press(reached.target)).then((found) => {
        if (!found) console.error(`replica: no control "${reached.target.key}" to press in chapter ${String(chapter)}`)
      })
    }
  }, [ready, reduced, epoch, presses, press, chapter])

  const select = useCallback((next: number) => {
    setChapter(next)
    setAt(0)
    setEpoch(value => value + 1)
    setEnded(false)
    setPaused(false)
  }, [])
  const toggle = useCallback(() => {
    if (ended) select(0)
    else setPaused(value => !value)
  }, [ended, select])
  return { chapter, state, epoch, playing, paused, ended, reduced, select, toggle }
}
