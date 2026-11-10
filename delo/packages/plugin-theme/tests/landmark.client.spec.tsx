// @vitest-environment jsdom
/** The main landmark: the frame's main pane gets `role="main"` while the Delo look is on, also after the frame renders it anew. */
import { afterEach, describe, expect, it } from 'vitest'
import { markMainLandmark } from '../src/client/landmark.ts'

const flush = async (): Promise<void> => { await new Promise<void>(resolve => { setTimeout(resolve, 0) }) }

function pane(): HTMLElement {
  const element = document.createElement('div')
  element.setAttribute('data-slot', 'main')
  document.body.append(element)
  return element
}

afterEach(() => { document.body.replaceChildren() })

describe('markMainLandmark', () => {
  it('marks the main pane that is already on the page', () => {
    const element = pane()
    const dispose = markMainLandmark(document)
    expect(element.getAttribute('role')).toBe('main')
    dispose()
  })

  it('marks a pane the frame renders later, and the one that replaces it', async () => {
    const dispose = markMainLandmark(document)
    const first = pane()
    await flush()
    expect(first.getAttribute('role')).toBe('main')
    document.body.append(document.createElement('span'))
    await flush()
    expect(first.getAttribute('role')).toBe('main')
    first.remove()
    const second = pane()
    await flush()
    expect(second.getAttribute('role')).toBe('main')
    dispose()
  })

  it('leaves a pane alone that already has a role, and does nothing while there is no pane', async () => {
    const dispose = markMainLandmark(document)
    document.body.append(document.createElement('span'))
    await flush()
    const element = pane()
    element.setAttribute('role', 'region')
    await flush()
    expect(element.getAttribute('role')).toBe('region')
    dispose()
    expect(element.getAttribute('role')).toBe('region')
  })

  it('takes the role off and stops watching once disposed', async () => {
    const element = pane()
    const dispose = markMainLandmark(document)
    dispose()
    expect(element.hasAttribute('role')).toBe(false)
    const later = pane()
    await flush()
    expect(later.hasAttribute('role')).toBe(false)
  })

  it('has nothing to take off when no pane was marked', () => {
    expect(() => { markMainLandmark(document)() }).not.toThrow()
  })
})
