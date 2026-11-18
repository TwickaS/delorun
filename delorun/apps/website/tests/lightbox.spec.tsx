// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LightboxProvider, useOpenShot } from '../src/home/Lightbox.tsx'
import { SHOTS } from '../src/home/shots.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/** The stand-ins for running animations: each ends when the test calls its `onfinish`. */
let animations: Animation[] = []
let root: Root | undefined

beforeEach(() => {
  animations = []
  // jsdom has neither the dialog's methods nor the Web Animations API.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute('open') }
  Element.prototype.animate = function animate() {
    const fake = { onfinish: null, cancel: () => undefined } as Animation
    animations.push(fake)
    return fake
  }
  Element.prototype.getAnimations = () => []
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }))
  vi.stubGlobal('Image', class { decode = () => new Promise<void>(() => undefined); src = '' })
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })
})

afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

/** One button per picture, each opening its picture. */
function Tiles({ ids }: { ids: readonly string[] }): ReactNode {
  const open = useOpenShot()
  return ids.map(id => createElement('button', { key: id, type: 'button', 'data-shot': id, onClick: (event: { currentTarget: HTMLElement }) => open(id, event.currentTarget) }, id))
}

/** Renders the lightbox with tiles for the first pictures of the wall. */
async function page(count = 3): Promise<{ tiles: HTMLButtonElement[]; dialog: HTMLDialogElement; ids: string[] }> {
  const ids = SHOTS.slice(0, count).map(shot => shot.id)
  const container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => { root!.render(createElement(LightboxProvider, null, createElement(Tiles, { ids }))) })
  return { tiles: [...container.querySelectorAll<HTMLButtonElement>('button[data-shot]')], dialog: document.querySelector('dialog')!, ids }
}

/** The pictures the dialog shows. */
const shown = (dialog: HTMLDialogElement): HTMLImageElement[] => [...dialog.querySelectorAll('img')]

describe('the lightbox', () => {
  it('opens on the pressed tile with a picture on show and a caption plate that names the picture and the credit', async () => {
    const { tiles, dialog, ids } = await page()
    await act(async () => { tiles[1]!.click() })
    expect(dialog.open).toBe(true)
    const pictures = shown(dialog)
    expect(pictures.length).toBeGreaterThan(0)
    expect(pictures.every(img => img.getAttribute('src')?.includes('/lod/'))).toBe(true)
    expect(pictures[0]!.getAttribute('src')).toContain(ids[1])
    expect(dialog.textContent).toContain(SHOTS[1]!.caption)
    expect(dialog.textContent).toContain('A real Delorun screenshot, scaled, not retouched.')
  })

  it('always shows a picture while stepping with the arrow keys, wrapping at both ends', async () => {
    const { tiles, dialog } = await page()
    await act(async () => { tiles[0]!.click() })
    const key = async (name: string) => { await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })) }) }
    await key('ArrowLeft')
    expect(dialog.textContent).toContain(SHOTS[SHOTS.length - 1]!.caption)
    expect(shown(dialog).length).toBeGreaterThan(0)
    await key('ArrowRight')
    await key('ArrowRight')
    expect(dialog.textContent).toContain(SHOTS[1]!.caption)
    expect(shown(dialog).every(img => (img.getAttribute('src') ?? '') !== '')).toBe(true)
  })

  it('stays open on the new picture when a tile is pressed while the last close is still running', async () => {
    const { tiles, dialog } = await page()
    await act(async () => { tiles[0]!.click() })
    animations.length = 0
    const closeButton = [...dialog.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Close')!
    await act(async () => { closeButton.click() })
    const closing = animations.at(-1)!
    expect(closing.onfinish).not.toBeNull()
    // The visitor presses another tile before the close has ended; the close that was running must not shut it.
    await act(async () => { tiles[2]!.click() })
    await act(async () => { closing.onfinish?.(new Event('finish') as AnimationPlaybackEvent) })
    expect(dialog.open).toBe(true)
    expect(dialog.textContent).toContain(SHOTS[2]!.caption)
    expect(shown(dialog).length).toBeGreaterThan(0)
  })

  it('closes when its close animation ends, and gives focus back to the tile it grew from', async () => {
    const { tiles, dialog } = await page()
    await act(async () => { tiles[1]!.click() })
    animations.length = 0
    const closeButton = [...dialog.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Close')!
    await act(async () => { closeButton.click() })
    await act(async () => { animations.at(-1)!.onfinish?.(new Event('finish') as AnimationPlaybackEvent) })
    expect(dialog.open).toBe(false)
    expect(document.activeElement).toBe(tiles[1])
  })
})
