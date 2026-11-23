/**
 * The guide's gates ask `pageAtComputer`, which asks the desktop's home kind before the host name. This fails when a client
 * source other than `host-api.ts` reads the page host name or tests it for a loopback name again, which would be wrong in
 * the desktop app, where the host is `app`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CLIENT = fileURLToPath(new URL('../src/client', import.meta.url))
const sources = readdirSync(CLIENT, { recursive: true, encoding: 'utf8' }).filter(file => /\.(ts|tsx)$/.test(file))

describe('the guide\'s client gates', () => {
  it('finds the client sources', () => {
    expect(sources).toContain('index.ts')
    expect(sources).toContain('host-api.ts')
  })

  it.each(sources.filter(file => file !== 'host-api.ts'))('%s does not read the host name or isLoopback itself', (file) => {
    const text = readFileSync(join(CLIENT, file), 'utf8')
    expect(text).not.toMatch(/location\.hostname|isLoopbackHostname|\bisLoopback\b/)
  })

  it('routes its three gates through pageAtComputer', () => {
    const index = readFileSync(join(CLIENT, 'index.ts'), 'utf8')
    expect(index).toMatch(/atComputer: pageAtComputer,/)
    expect(index).toMatch(/remote: !pageAtComputer\(\),/)
    expect(readFileSync(join(CLIENT, 'host-api.ts'), 'utf8')).toMatch(/if \(!pageAtComputer\(\)\) return 'remote'/)
  })
})
