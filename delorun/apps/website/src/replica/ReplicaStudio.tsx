/**
 * The live drawn studio: the session's fixture played through the simplified chat and Delorun's real sections, in the
 * wrapper that carries the scoped studio tokens. It is inert: it takes no focus and no press, and assistive technology
 * reads the chapter's caption instead (`ReplicaLive.tsx`). It loads in the browser only, as a chunk of its own, with
 * the session's fixture as another; the player in `ReplicaLive.tsx` tells it what to show and which control to press.
 * In a terminal chapter it draws the terminal window in the studio's place. On Setup versions it scrolls the section
 * to its list of saved versions, which is what the chapter is about, once the section has drawn it.
 * @module @delorun/website/replica/ReplicaStudio
 */
import 'virtual:replica-tokens.css'
import strings from 'virtual:replica-strings'
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from 'react'
import { shiftClock, type ChapterFile, type PressTarget, type ReplicaFixture, type Screen, type StudioState } from './model.ts'
import { ChatScreen } from './screens/ChatScreen.tsx'
import { RealApproval, RealChanges, RealVersions, SECTION_DICTIONARIES } from './screens/real.tsx'
import { StudioLayout, type ReplicaWidth } from './screens/StudioLayout.tsx'
import { TerminalWindow } from './screens/TerminalWindow.tsx'
import { loadFixture } from './sessions/index.ts'
import { IconSprite } from './studio/icons.tsx'
import live from './screens/live.module.css'
import css from './screens/studio.module.css'
import { WRAPPER_PROPS } from './wrapper.ts'

/** What the player asks of the drawn studio. */
export interface StudioHandle {
  /**
   * Show a press on a control and press it.
   * @param target - the control.
   * @returns whether the control was found.
   */
  readonly press: (target: PressTarget) => Promise<boolean>
}

/** The props of {@link Studio}. */
export interface StudioProps {
  readonly file: ChapterFile
  readonly width: ReplicaWidth
  readonly state: StudioState
  /** Changes when a chapter starts, so the real sections start again from the chapter's first state. */
  readonly epoch: number
  readonly handle: Ref<StudioHandle | null>
  /** Called once the fixture has arrived and the studio draws it. */
  readonly onReady: () => void
}

/**
 * The time the brand gives a press, from the studio's own style.
 * @param element - an element inside the studio.
 * @returns milliseconds.
 */
function pressTime(element: Element): number {
  const value = getComputedStyle(element).getPropertyValue('--dl-motion-press').trim()
  const ms = value.endsWith('ms') ? Number.parseFloat(value) : value.endsWith('s') ? Number.parseFloat(value) * 1000 : Number.NaN
  return Number.isFinite(ms) ? ms : 0
}

/**
 * Find a button by its text inside a region of the studio.
 * @param root - the studio.
 * @param target - the control.
 * @returns the button, or undefined.
 */
export function findTarget(root: ParentNode, target: PressTarget): HTMLButtonElement | undefined {
  const dictionary: Readonly<Record<string, string>> = SECTION_DICTIONARIES[target.dictionary]
  const label = dictionary[target.key]
  const region = target.within === undefined ? root : root.querySelector(target.within)
  if (region === null) return undefined
  return [...region.querySelectorAll('button')].find(button => button.textContent?.trim() === label)
}

/**
 * Scroll a screen so the settings card holding the first saved version sits at its top.
 * @param screen - the screen's scrolling element.
 * @returns whether the list was there to scroll to.
 */
function revealVersions(screen: HTMLElement): boolean {
  const row = screen.querySelector('[data-version]')
  const card = row?.closest('section') ?? row
  if (card == null) return false
  screen.scrollTop += card.getBoundingClientRect().top - screen.getBoundingClientRect().top - Number.parseFloat(getComputedStyle(screen).paddingTop)
  return true
}

/** How many frames the incoming chapter gets to draw its first state before the outgoing one fades; the fade starts early if it is drawn. */
const SETTLE_FRAMES = 30

/**
 * The chapter that has just ended, kept painted above the new one as an inert copy until the new one has drawn its first
 * state, then faded out (and removed at once under reduced motion). The studio is never shown empty between chapters.
 * @param props - the copy's markup, the new chapter's root, the screen it shows, and what to call when the copy can go.
 * @returns the copy.
 */
function Outgoing({ html, root, screen, onDone }: { readonly html: string, readonly root: RefObject<HTMLElement | null>, readonly screen: Screen, readonly onDone: () => void }) {
  const [fading, setFading] = useState(false)
  useEffect(() => {
    let frames = 0
    let frame = 0
    const settled = (): boolean => {
      // Setup versions asks for its list after its first render; every other screen is drawn by then.
      if (screen !== 'versions') return frames >= 2
      return frames >= 2 && root.current?.querySelector('[data-version]') != null
    }
    const tick = () => {
      frames += 1
      if (settled() || frames >= SETTLE_FRAMES) setFading(true)
      else frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame) }
  }, [root, screen])
  useEffect(() => {
    if (!fading) return
    const timer = setTimeout(onDone, FADE_LIMIT)
    return () => { clearTimeout(timer) }
  }, [fading, onDone])
  return <div className={live.outgoing} data-outgoing="" data-fading={fading ? '' : undefined} aria-hidden="true" inert onTransitionEnd={(event) => { if (event.target === event.currentTarget) onDone() }} dangerouslySetInnerHTML={{ __html: html }} />
}

/** The longest the fade takes before the copy is removed whether or not the browser reported its end, in milliseconds. */
const FADE_LIMIT = 400

/**
 * Render the drawn studio.
 * @param props - see {@link StudioProps}.
 * @returns the studio, or nothing until its fixture arrives.
 */
export default function Studio({ file, width, state, epoch, handle, onReady }: StudioProps) {
  const root = useRef<HTMLDivElement>(null)
  const [fixture, setFixture] = useState<ReplicaFixture | undefined>()
  useEffect(() => {
    let current = true
    // Without its fixture the studio is never ready, so the frame keeps its still.
    loadFixture(file.session).then(
      (loaded) => { if (current) setFixture(shiftClock(loaded, Date.now() - Date.parse(loaded.clock))) },
      (error: unknown) => { console.error('The studio replay did not load.', error) },
    )
    return () => { current = false }
  }, [file.session])
  useEffect(() => { if (fixture !== undefined) onReady() }, [fixture, onReady])
  useImperativeHandle(handle, () => ({
    press: async (target) => {
      const button = root.current === null ? undefined : findTarget(root.current, target)
      if (button === undefined) return false
      button.dataset['replicaPress'] = ''
      await new Promise(resolve => setTimeout(resolve, pressTime(button)))
      delete button.dataset['replicaPress']
      button.click()
      return true
    },
  }), [])
  const onVersions = state.screen === 'versions' && fixture !== undefined
  useEffect(() => {
    const screen = onVersions ? root.current?.querySelector<HTMLElement>('[data-screen="versions"]') : undefined
    if (screen == null || revealVersions(screen)) return
    // The section asks for its list after its first render, so the rows arrive a moment later.
    const observer = new MutationObserver(() => { if (revealVersions(screen)) observer.disconnect() })
    observer.observe(screen, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [onVersions, epoch])
  const [seenEpoch, setSeenEpoch] = useState(epoch)
  const [outgoing, setOutgoing] = useState<string | undefined>()
  // A new chapter draws its sections from their first state; the chapter before stays painted over it until then.
  if (seenEpoch !== epoch) {
    setSeenEpoch(epoch)
    setOutgoing(root.current === null ? undefined : root.current.outerHTML.replace(/\sid="[^"]*"/g, ''))
  }
  const dropOutgoing = useCallback(() => { setOutgoing(undefined) }, [])
  if (fixture === undefined) return null
  const changes = fixture.changes[state.changes]
  const versions = fixture.versions[state.versions]
  const { screen } = state
  return <>
    <div ref={root} {...WRAPPER_PROPS} className={css.root} inert>
      <IconSprite />
      {screen === 'terminal'
        ? <TerminalWindow terminal={state.terminal} output={fixture.terminal?.output ?? []} />
        : <StudioLayout file={file} width={width} screen={screen} strings={strings} screens={{
            chat: <ChatScreen events={fixture.events} shown={state.shown} draft={state.draft} typing={state.typing} strings={strings}
              approval={pending => <RealApproval key={`${String(epoch)} ${pending.id}`} pending={pending} />} />,
            changes: changes === undefined ? null : <RealChanges key={epoch} state={changes} groups={state.groups} />,
            versions: versions === undefined ? null : <RealVersions key={epoch} versions={versions} changes={fixture.versionChanges} />,
          }} />}
    </div>
    {outgoing === undefined ? null : <Outgoing key={seenEpoch} html={outgoing} root={root} screen={state.screen} onDone={dropOutgoing} />}
  </>
}