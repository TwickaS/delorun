/**
 * The studio's computer-only gates in this package ask `pageAtComputer`, which asks the desktop's home kind before the
 * connection's `isLoopback`. A gate that reads `isLoopback` itself would be wrong in the desktop app, where the page host is
 * `app` and `isLoopback` is false for a home on the person's own computer. This fails when any client source other than
 * `at-computer.ts` mentions `isLoopback` or tests the page host name for a loopback name again.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CLIENT = fileURLToPath(new URL('../src/client', import.meta.url))
const sources = readdirSync(CLIENT, { recursive: true, encoding: 'utf8' }).filter(file => /\.(ts|tsx)$/.test(file))

describe('the bundle\'s client gates', () => {
  it('finds the client sources', () => {
    expect(sources).toContain('index.ts')
    expect(sources).toContain('at-computer.ts')
  })

  it.each(sources.filter(file => file !== 'at-computer.ts'))('%s does not read isLoopback or the host name itself', (file) => {
    const text = readFileSync(join(CLIENT, file), 'utf8')
    expect(text).not.toMatch(/\bisLoopback\b/)
    expect(text).not.toMatch(/location\.hostname|isLoopbackHostname|isLoopbackHost\b/)
  })

  it('makes every computer-only gate in index.ts go through pageAtComputer', () => {
    const text = readFileSync(join(CLIENT, 'index.ts'), 'utf8')
    expect(text.match(/pageAtComputer\(ctx\)/g)?.length).toBe(10)
  })
})
