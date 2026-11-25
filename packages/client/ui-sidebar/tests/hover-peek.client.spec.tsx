// @vitest-environment jsdom
/**
 * The collapsed shell's hover peek: which pointer and focus signals open the
 * expanded overlay over the page, and that closing restores the rail. The
 * overlay's fixed geometry and tokens are the stylesheet's (sidebar-styles);
 * the expanded width arrives as the frame's CSS variable (ui-layout).
 */
import { contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { allowAllAccess } from '@deepseek-ai/dsh-client-test-runtime'
import type { SidebarHoverPeek, SidebarRootComponentProps, SidebarSectionOwnerProps } from '../src/client/contract/slots.ts'
import { SidebarRoot } from '../src/client/SidebarRoot.tsx'
import { en } from '../src/client/locales.ts'

/** Pointer dwell the shell waits before it opens the peek. */
const PEEK_HOVER_DELAY_MS = 350
/** Grace between the pointer leaving and the close fade starting. */
const PEEK_CLOSE_GRACE_MS = 250
/** Close fade the shell keeps the expanded content mounted for. */
const PEEK_SETTLE_MS = 140

const t: SidebarRootComponentProps['t'] = key => (en as Record<string, string>)[key] ?? key
/** The shell never reads the global hooks; the props share carries them regardless. */
const neverHook = (() => { throw new Error('shell must not read global hooks') }) as never
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })
type AttentionSnapshot = Parameters<Parameters<SidebarRootComponentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: SidebarRootComponentProps['useSessionStatus'] = selector => selector(noAttention)

/**
 * Answer the shell's hover-capability probe.
 * @param hover - whether the device reports a hovering fine pointer.
 */
function stubHoverCapability(hover: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: hover && query === '(hover: hover) and (pointer: fine)',
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })))
}

interface MountOptions {
  collapsed?: boolean
  drawer?: boolean
  width?: number
  hoverPeek?: SidebarHoverPeek
}

/**
 * Mount the shell over one region control, and expose the state the peek drives.
 * @param options - the column owner share to mount with.
 * @returns the column element, the seats' wide flags, and a focus probe.
 */
function mountRail(options: MountOptions = {}) {
  const { collapsed = true, drawer = false } = options
  const width = options.width ?? (collapsed ? 56 : 280)
  let regionOwner: SidebarSectionOwnerProps | undefined
  const startSession = vi.fn()
  const toggleSidebar = vi.fn()
  let hoverPeek: SidebarHoverPeek = options.hoverPeek ?? { enabled: true, delayMs: PEEK_HOVER_DELAY_MS }
  const tree = () => (
    <SidebarRoot
      drawer={drawer}
      collapsed={collapsed} width={width}
      useSessions={neverHook} useSessionStatus={useSessionStatus} useSessionRetainInfo={neverHook}
      usePanelInfo={usePanelInfo} selectPanel={() => {}} usePanels={selector => selector([])} useEntryPins={selector => selector([])}
      useEntryActions={selector => selector(false)} usePanelPlacement={placementSelector => placementSelector('top')}
      useLeadPanel={leadSelector => leadSelector(null)} useNewSessionButton={shownSelector => shownSelector(true)}
      useFootRow={rowSelector => rowSelector(false)} useHoverPeek={peekSelector => peekSelector(hoverPeek)} setPinned={vi.fn()}
      useShortcuts={selector => selector([])}
      useContextMenu={contextMenuHook()} useResource={useResource} useWorkspaces={neverHook} renderFactorySlot={() => null}
      {...allowAllAccess}
      startSession={startSession} toggleSidebar={toggleSidebar} trackEntryClick={vi.fn()} t={t}
      renderSlot={((key: string, owner: SidebarSectionOwnerProps, options?: { children?: ReactNode }) => {
        if (key === 'sidebar.brand.mark') return <span data-testid="brand-mark">M</span>
        if (key === 'sidebar.brand.name') return <span data-testid="brand-name">Brand</span>
        if (key === 'sidebar.backdrop') return null
        if (key === 'sidebar.toggle.badge') return null
        if (key === 'sidebar.brand.badge') return null
        if (key === 'sidebar.settings') return <div data-testid="settings-seat" data-wide={owner.wide} />
        if (key === 'sidebar.footer.action') return null
        if (key === 'sidebar.session.action') return options?.children ?? null
        if (key === 'sidebar.sections') return null
        regionOwner = owner
        return <div data-testid="region" data-wide={owner.wide}><PeekControl /></div>
      }) as SidebarRootComponentProps['renderSlot']}
    />
  )
  const view = render(tree())
  const column = view.container.firstElementChild
  if (!(column instanceof HTMLElement)) throw new Error('sidebar column not rendered')
  return {
    column,
    startSession,
    toggleSidebar,
    /** Change the hover-peek setting under the mounted shell, as the layout service does. */
    setHoverPeek: (next: SidebarHoverPeek): void => { hoverPeek = next; view.rerender(tree()) },
    regionWide: (): boolean => {
      if (regionOwner === undefined) throw new Error('region owner not rendered')
      return regionOwner.wide
    },
  }
}

/** The panel's own control, used to prove focus inside it keeps the peek open. */
function PeekControl() {
  return <button type="button" data-testid="peek-control">Search sessions</button>
}

/**
 * Advance the shell's timers by one step.
 * @param ms - milliseconds to advance.
 */
function advance(ms: number): void {
  act(() => { vi.advanceTimersByTime(ms) })
}

/** Whether the column is presenting the peek overlay. */
function peekAttribute(column: HTMLElement): string | null {
  return column.getAttribute('data-sidebar-peek')
}

/**
 * Pin the panel's box, which jsdom lays out as zero-sized, so a pointer
 * coordinate can be inside or outside the open overlay.
 * @param column - the sidebar column element.
 */
function stubPeekBox(column: HTMLElement): void {
  Object.defineProperty(column, 'getBoundingClientRect', {
    value: () => ({
      left: 0, top: 0, right: 280, bottom: 600,
      x: 0, y: 0, width: 280, height: 600, toJSON: () => ({}),
    }),
  })
}

/**
 * Open the peek through the pointer dwell.
 * @param column - the sidebar column element.
 */
function openPeek(column: HTMLElement): void {
  fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
  advance(PEEK_HOVER_DELAY_MS)
  expect(peekAttribute(column)).toBe('open')
}

beforeEach(() => { vi.useFakeTimers() })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('SidebarRoot hover peek', () => {
  it('lifts the collapsed rail into the expanded shell only after a pointer dwell', () => {
    stubHoverCapability(true)
    const { column, regionWide } = mountRail()
    expect(regionWide()).toBe(false)
    fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
    expect(peekAttribute(column)).toBeNull()
    advance(PEEK_HOVER_DELAY_MS - 1)
    expect(peekAttribute(column)).toBeNull()
    advance(1)
    expect(peekAttribute(column)).toBe('open')
    // The expanded shell, at the frame's open width, with the wide-only seats.
    expect(regionWide()).toBe(true)
    expect(screen.getByTestId('region').getAttribute('data-wide')).toBe('true')
    expect(column.className).toMatch(/peeking/)
    expect(column.className).not.toMatch(/collapsed|fading/)
    // The width is the frame's variable, not an inline measurement.
    expect(column.style.width).toBe('')
    // It is a view of the collapsed state: nothing was pinned or persisted.
    expect(column.getAttribute('aria-hidden')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeTruthy()
  })

  it('closes after the pointer leaves, with a short fade and the rail restored intact', () => {
    stubHoverCapability(true)
    const { column, regionWide } = mountRail()
    fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
    advance(PEEK_HOVER_DELAY_MS)
    expect(peekAttribute(column)).toBe('open')
    fireEvent.pointerOut(column, { relatedTarget: document.body })
    expect(peekAttribute(column)).toBe('open')
    advance(PEEK_CLOSE_GRACE_MS - 1)
    expect(peekAttribute(column)).toBe('open')
    advance(1)
    expect(peekAttribute(column)).toBe('closing')
    expect(column.className).toMatch(/peekClosing/)
    advance(PEEK_SETTLE_MS - 1)
    expect(regionWide()).toBe(true)
    advance(1)
    expect(peekAttribute(column)).toBeNull()
    expect(regionWide()).toBe(false)
    // The rail is the same element with its own control, and no inline width.
    expect(column.className).toMatch(/collapsed/)
    expect(column.style.width).toBe('')
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeTruthy()
  })

  it('reopens at once when the pointer returns during the close fade', () => {
    stubHoverCapability(true)
    const { column } = mountRail()
    fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
    advance(PEEK_HOVER_DELAY_MS)
    fireEvent.pointerOut(column, { relatedTarget: document.body })
    advance(PEEK_CLOSE_GRACE_MS)
    expect(peekAttribute(column)).toBe('closing')
    fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 40, clientY: 300 })
    expect(peekAttribute(column)).toBe('open')
    advance(PEEK_SETTLE_MS)
    expect(peekAttribute(column)).toBe('open')
  })

  it('keeps the peek when the pointer returns inside the grace, and closes a full grace after a second leave', () => {
    stubHoverCapability(true)
    const { column } = mountRail()
    openPeek(column)
    fireEvent.pointerOut(column, { relatedTarget: document.body })
    advance(PEEK_CLOSE_GRACE_MS - 1)
    fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 40, clientY: 300 })
    advance(PEEK_CLOSE_GRACE_MS * 2)
    expect(peekAttribute(column)).toBe('open')
    fireEvent.pointerOut(column, { relatedTarget: document.body })
    advance(PEEK_CLOSE_GRACE_MS - 1)
    expect(peekAttribute(column)).toBe('open')
    advance(1)
    expect(peekAttribute(column)).toBe('closing')
  })

  it('keeps the peek when the pointer moves back into the panel box inside the grace', () => {
    stubHoverCapability(true)
    const { column } = mountRail()
    stubPeekBox(column)
    openPeek(column)
    fireEvent.pointerMove(document, { clientX: 900, clientY: 300 })
    fireEvent.pointerMove(document, { clientX: 950, clientY: 300 })
    advance(PEEK_CLOSE_GRACE_MS - 1)
    fireEvent.pointerMove(document, { clientX: 100, clientY: 300 })
    advance(PEEK_CLOSE_GRACE_MS * 2)
    expect(peekAttribute(column)).toBe('open')
  })

  it('closes on Escape and hands focus from the disappearing panel to the rail toggle', () => {
    stubHoverCapability(true)
    const { column } = mountRail()
    fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
    advance(PEEK_HOVER_DELAY_MS)
    const control = screen.getByTestId('peek-control')
    act(() => { control.focus() })
    expect(peekAttribute(column)).toBe('open')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(peekAttribute(column)).toBe('closing')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open sidebar' }))
    advance(PEEK_SETTLE_MS)
    expect(peekAttribute(column)).toBeNull()
  })

  it('keeps the panel while focus is inside it and closes when focus leaves', () => {
    stubHoverCapability(true)
    const { column } = mountRail()
    fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
    advance(PEEK_HOVER_DELAY_MS)
    const control = screen.getByTestId('peek-control')
    act(() => { control.focus() })
    advance(PEEK_SETTLE_MS)
    expect(peekAttribute(column)).toBe('open')
    act(() => { control.blur() })
    expect(peekAttribute(column)).toBe('closing')
    advance(PEEK_SETTLE_MS)
    expect(peekAttribute(column)).toBeNull()
  })

  it('never opens for a coarse pointer, and never opens on touch input', () => {
    stubHoverCapability(false)
    const coarse = mountRail()
    fireEvent.pointerOver(coarse.column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
    advance(1000)
    expect(peekAttribute(coarse.column)).toBeNull()
    expect(coarse.regionWide()).toBe(false)
    cleanup()
    stubHoverCapability(true)
    const touch = mountRail()
    fireEvent.pointerOver(touch.column, { relatedTarget: document.body, clientX: 30, clientY: 300, pointerType: 'touch' })
    advance(1000)
    expect(peekAttribute(touch.column)).toBeNull()
  })

  it('leaves every rail control alone: resting on one never arms the peek', () => {
    stubHoverCapability(true)
    const { column } = mountRail()
    const toggle = screen.getByRole('button', { name: 'Open sidebar' })
    fireEvent.pointerOver(toggle, { relatedTarget: document.body, clientX: 28, clientY: 36 })
    advance(1000)
    expect(peekAttribute(column)).toBeNull()
    // Passing over the rail's surface and then onto a control disarms it too.
    fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 54, clientY: 300 })
    fireEvent.pointerMove(toggle, { clientX: 28, clientY: 36 })
    advance(1000)
    expect(peekAttribute(column)).toBeNull()
    // Leaving the control re-arms the dwell on the next move over the rail.
    fireEvent.pointerMove(column, { clientX: 54, clientY: 300 })
    advance(PEEK_HOVER_DELAY_MS)
    expect(peekAttribute(column)).toBe('open')
  })

  it('does not open while the column is expanded or inside the phone drawer', () => {
    stubHoverCapability(true)
    const expanded = mountRail({ collapsed: false })
    fireEvent.pointerOver(expanded.column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
    advance(1000)
    expect(peekAttribute(expanded.column)).toBeNull()
    cleanup()
    const drawer = mountRail({ drawer: true, width: 280 })
    fireEvent.pointerOver(drawer.column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
    advance(1000)
    expect(peekAttribute(drawer.column)).toBeNull()
  })

  it('opens from the left screen edge where the platform hides the collapsed column', () => {
    stubHoverCapability(true)
    const { column, regionWide } = mountRail({ width: 0 })
    fireEvent.pointerMove(document, { clientX: 4, clientY: 300 })
    advance(PEEK_HOVER_DELAY_MS)
    expect(peekAttribute(column)).toBe('open')
    expect(regionWide()).toBe(true)
  })

  it('cancels the left-edge dwell when the pointer moves back into the page', () => {
    stubHoverCapability(true)
    const { column } = mountRail({ width: 0 })
    fireEvent.pointerMove(document, { clientX: 4, clientY: 300 })
    advance(PEEK_HOVER_DELAY_MS - 1)
    fireEvent.pointerMove(document, { clientX: 300, clientY: 300 })
    advance(1000)
    expect(peekAttribute(column)).toBeNull()
  })

  it('never writes the persisted collapse state', () => {
    stubHoverCapability(true)
    const { column, toggleSidebar, startSession } = mountRail()
    fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
    advance(PEEK_HOVER_DELAY_MS)
    fireEvent.pointerOut(column, { relatedTarget: document.body })
    advance(PEEK_SETTLE_MS)
    expect(toggleSidebar).not.toHaveBeenCalled()
    expect(startSession).not.toHaveBeenCalled()
  })

  it('drops a pending open when the shell unmounts', () => {
    stubHoverCapability(true)
    const { column } = mountRail()
    fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
    cleanup()
    expect(() => { advance(1000) }).not.toThrow()
  })

  it('never opens where the view has no matchMedia', () => {
    // Views without media queries (jsdom, some embedded browsers) keep only
    // the explicit expand control.
    vi.stubGlobal('matchMedia', undefined)
    const { column, regionWide } = mountRail()
    fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
    advance(1000)
    expect(peekAttribute(column)).toBeNull()
    expect(regionWide()).toBe(false)
  })

  it('drops the pending open when a dialog opens during the dwell', () => {
    stubHoverCapability(true)
    const { column } = mountRail()
    fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
    render(<Modal open title="Settings" closeLabel="Close" onClose={vi.fn()}><button type="button">Settings control</button></Modal>)
    advance(PEEK_HOVER_DELAY_MS)
    expect(peekAttribute(column)).toBeNull()
  })

  it('never opens behind an open dialog', () => {
    stubHoverCapability(true)
    const { column } = mountRail()
    render(<Modal open title="Settings" closeLabel="Close" onClose={vi.fn()}><button type="button">Settings control</button></Modal>)
    fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
    advance(1000)
    expect(peekAttribute(column)).toBeNull()
  })

  it('keeps focus cases that stay within the peek, and closes when focus leaves to the page', () => {
    stubHoverCapability(true)
    const { column } = mountRail()
    // A blur outside any peek is ignored.
    fireEvent.focusOut(screen.getByTestId('peek-control'), { relatedTarget: document.body })
    expect(peekAttribute(column)).toBeNull()
    openPeek(column)
    const control = screen.getByTestId('peek-control')
    const toggle = screen.getByRole('button', { name: 'Open sidebar' })
    act(() => { control.focus() })
    // Focus moving to another control of the panel stays inside it.
    act(() => { toggle.focus() })
    fireEvent.focusOut(control, { relatedTarget: toggle })
    advance(PEEK_SETTLE_MS)
    expect(peekAttribute(column)).toBe('open')
    // Focus moving into a menu the panel opened is still the panel's task.
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('button')
    item.type = 'button'
    menu.append(item)
    document.body.append(menu)
    try {
      act(() => { control.focus() })
      fireEvent.focusOut(control, { relatedTarget: item })
      advance(PEEK_SETTLE_MS)
      expect(peekAttribute(column)).toBe('open')
    } finally {
      menu.remove()
    }
    // Focus moving anywhere else ends it.
    act(() => { control.focus() })
    fireEvent.focusOut(control, { relatedTarget: document.body })
    expect(peekAttribute(column)).toBe('closing')
  })

  it('closes from the panel box when the pointer moves to the page', () => {
    stubHoverCapability(true)
    const { column } = mountRail()
    stubPeekBox(column)
    openPeek(column)
    // Inside the box: the peek stays.
    fireEvent.pointerMove(document, { clientX: 100, clientY: 300 })
    expect(peekAttribute(column)).toBe('open')
    // Right of the box.
    fireEvent.pointerMove(document, { clientX: 900, clientY: 300 })
    advance(PEEK_CLOSE_GRACE_MS)
    expect(peekAttribute(column)).toBe('closing')
    advance(PEEK_SETTLE_MS)
    openPeek(column)
    // Below the box.
    fireEvent.pointerMove(document, { clientX: 100, clientY: 900 })
    advance(PEEK_CLOSE_GRACE_MS)
    expect(peekAttribute(column)).toBe('closing')
    advance(PEEK_SETTLE_MS)
    openPeek(column)
    // Above the box.
    fireEvent.pointerMove(document, { clientX: 100, clientY: -5 })
    advance(PEEK_CLOSE_GRACE_MS)
    expect(peekAttribute(column)).toBe('closing')
    advance(PEEK_SETTLE_MS)
    openPeek(column)
    // A move over a menu the panel opened is not leaving.
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.append(menu)
    try {
      fireEvent.pointerMove(menu, { clientX: 900, clientY: 300 })
      expect(peekAttribute(column)).toBe('open')
    } finally {
      menu.remove()
    }
  })

  it('ignores pointer moves once open and while the column is expanded, in the drawer, or on touch', () => {
    stubHoverCapability(true)
    const expandedRail = mountRail({ collapsed: false })
    fireEvent.pointerMove(expandedRail.column, { clientX: 100, clientY: 300 })
    advance(1000)
    expect(peekAttribute(expandedRail.column)).toBeNull()
    cleanup()
    const drawer = mountRail({ drawer: true, width: 280 })
    fireEvent.pointerMove(drawer.column, { clientX: 100, clientY: 300 })
    advance(1000)
    expect(peekAttribute(drawer.column)).toBeNull()
    cleanup()
    const { column } = mountRail()
    fireEvent.pointerMove(column, { pointerType: 'touch', clientX: 100, clientY: 300 })
    advance(1000)
    expect(peekAttribute(column)).toBeNull()
    // While open the move is the overlay's own navigation, not a re-arm.
    stubPeekBox(column)
    openPeek(column)
    fireEvent.pointerMove(column, { clientX: 100, clientY: 300 })
    expect(peekAttribute(column)).toBe('open')
  })

  it('closes on Escape only, and hands a repeated close back to the fade', () => {
    stubHoverCapability(true)
    const { column } = mountRail()
    openPeek(column)
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(peekAttribute(column)).toBe('open')
    // A handler that consumed the key keeps the panel (the panel's own menus
    // close first).
    const prevented = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
    prevented.preventDefault()
    act(() => { document.dispatchEvent(prevented) })
    expect(peekAttribute(column)).toBe('open')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(peekAttribute(column)).toBe('closing')
    // A second close request during the fade changes nothing.
    fireEvent.pointerOut(column, { relatedTarget: document.body })
    expect(peekAttribute(column)).toBe('closing')
    advance(PEEK_SETTLE_MS)
    expect(peekAttribute(column)).toBeNull()
    // A leave after the peek is gone is a no-op.
    fireEvent.pointerOut(column, { relatedTarget: document.body })
    expect(peekAttribute(column)).toBeNull()
  })

  it('ignores touch on the hidden column left edge', () => {
    stubHoverCapability(true)
    const { column } = mountRail({ width: 0 })
    fireEvent.pointerMove(document, { pointerType: 'touch', clientX: 4, clientY: 300 })
    advance(1000)
    expect(peekAttribute(column)).toBeNull()
  })

  it('opens after the configured delay, not the default one', () => {
    stubHoverCapability(true)
    const { column } = mountRail({ hoverPeek: { enabled: true, delayMs: 1000 } })
    fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
    advance(PEEK_HOVER_DELAY_MS)
    expect(peekAttribute(column)).toBeNull()
    advance(1000 - PEEK_HOVER_DELAY_MS - 1)
    expect(peekAttribute(column)).toBeNull()
    advance(1)
    expect(peekAttribute(column)).toBe('open')
  })

  it('opens on the next tick with a zero delay', () => {
    stubHoverCapability(true)
    const { column } = mountRail({ hoverPeek: { enabled: true, delayMs: 0 } })
    fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
    advance(0)
    expect(peekAttribute(column)).toBe('open')
  })

  it('never opens while the peek is off, on the rail or at the left edge, and the expand control still works', () => {
    stubHoverCapability(true)
    const { column, toggleSidebar } = mountRail({ hoverPeek: { enabled: false, delayMs: 350 } })
    fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
    fireEvent.pointerMove(column, { clientX: 30, clientY: 300 })
    advance(5000)
    expect(peekAttribute(column)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
  })

  it('applies a change live: turning it off closes an open peek and drops a pending dwell, turning it on arms the next one', () => {
    stubHoverCapability(true)
    const { column, setHoverPeek } = mountRail()
    fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
    advance(PEEK_HOVER_DELAY_MS)
    expect(peekAttribute(column)).toBe('open')
    setHoverPeek({ enabled: false, delayMs: 350 })
    expect(peekAttribute(column)).toBeNull()
    fireEvent.pointerLeave(column)
    fireEvent.pointerOver(column, { relatedTarget: document.body, clientX: 30, clientY: 300 })
    advance(5000)
    expect(peekAttribute(column)).toBeNull()
    setHoverPeek({ enabled: true, delayMs: 100 })
    fireEvent.pointerMove(column, { clientX: 30, clientY: 300 })
    advance(100)
    expect(peekAttribute(column)).toBe('open')
  })
})
