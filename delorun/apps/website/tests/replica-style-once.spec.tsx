// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// The shared frame is replaced by its slots, so the test reaches the page itself.
vi.mock('../src/components/layout.tsx', () => ({
  Frame: ({ children, closing }: { children: ReactNode, closing?: ReactNode }) => createElement('div', null, children, closing),
}))
// The build's server module: each frame's markup carries no style, and the styles come once from `styles()`.
vi.mock('virtual:replica-island', () => ({ island: () => '<i data-frame=""></i>', styles: () => 'REPLICA-STYLE-TEXT' }))

describe('the replica\'s style on the home page', () => {
  it('is written once for the page, with the frames beside it carrying none', async () => {
    const { Home } = await import('../src/components/home.tsx')
    const html = renderToString(createElement(Home))
    expect(html.match(/REPLICA-STYLE-TEXT/g)).toHaveLength(1)
    expect(html).toContain('data-frame')
    expect(html.indexOf('REPLICA-STYLE-TEXT')).toBeLessThan(html.indexOf('data-frame'))
  })

  it('is not written by the lower sections or by the frame itself', () => {
    const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    expect(read('../src/components/home-below.tsx')).not.toContain('ReplicaStyle')
    expect(read('../src/replica/ReplicaFrame.tsx').match(/styles\(\)/g)).toHaveLength(1)
  })
})
