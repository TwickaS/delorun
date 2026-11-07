// @vitest-environment jsdom
/**
 * Remote images under a `remoteImages` delegate: an authored image from
 * another origin renders as a placeholder naming its host and no `<img>`
 * element, so the browser never requests it; the page's own origin and
 * owners without the delegate keep loading images.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarkdownDelegateProvider } from '../src/markdown/MarkdownDelegate.tsx'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const remoteImages = { placeholder: (host: string) => `Image from ${host} not loaded` }

function mount(text: string, delegate: { remoteImages?: typeof remoteImages } = { remoteImages }) {
  return render(<MarkdownDelegateProvider {...delegate}>
    <MarkdownText text={text} streaming={false} />
  </MarkdownDelegateProvider>)
}

it('renders an image from another origin as a placeholder naming its host, with no img element', () => {
  const view = mount('Look: ![a chart](https://images.example.org:8443/chart.png?x=1) and ![](http://tracker.example.net/p.gif)')
  expect(view.container.querySelector('img')).toBeNull()
  expect(screen.getByRole('img', { name: 'Image from images.example.org:8443 not loaded: a chart' }).textContent)
    .toBe('Image from images.example.org:8443 not loaded')
  expect(screen.getByRole('img', { name: 'Image from tracker.example.net not loaded' })).toBeTruthy()
})

it('keeps loading an image from the page\'s own origin', () => {
  const view = mount(`![own](${location.origin}/api/file?path=a.png)`)
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe(`${location.origin}/api/file?path=a.png`)
})

it('loads remote images when the owner gives no remoteImages delegate', () => {
  const view = mount('![a chart](https://images.example.org/chart.png)', {})
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe('https://images.example.org/chart.png')
})
