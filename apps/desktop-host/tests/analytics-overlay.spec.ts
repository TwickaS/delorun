import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ANALYTICS_OFF_OVERLAY_FILE, writeAnalyticsOffOverlay } from '../src/analytics-overlay.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('analytics-off overlay', () => {
  it('writes one patch that starts the product-analytics row disabled', () => {
    const directory = mkdtempSync(join(tmpdir(), 'desktop-host-overlay-'))
    directories.push(directory)
    const file = writeAnalyticsOffOverlay(join(directory, 'profile'))
    expect(file).toBe(join(directory, 'profile', ANALYTICS_OFF_OVERLAY_FILE))
    expect(statSync(file).isFile()).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([{ id: 'product-analytics', config: { enabled: false } }])
  })

  it('is the layer the Host boots with', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).toContain('patchFiles: [writeAnalyticsOffOverlay(projectDir)]')
  })
})
