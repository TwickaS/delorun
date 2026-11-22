// @vitest-environment jsdom
/** The browser download Browser needs: a row in the downloads panel from its start until the Host answers. */
import { BROWSER_DOWNLOAD_KEY, currentDownloadsSource } from '@delorun/plugin-downloads/row'
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserInstallAnswer } from '@delorun/bundle-local/browser-check-api'
import { downloadBrowserShown } from '../src/client/browser-pack.ts'

const row = () => currentDownloadsSource().snapshot().find(item => item.key === BROWSER_DOWNLOAD_KEY)
afterEach(() => { currentDownloadsSource().remove(BROWSER_DOWNLOAD_KEY) })

describe('the browser download in the downloads panel', () => {
  it('shows a download without a measure while the Host runs it, then added', async () => {
    let finish: (answer: BrowserInstallAnswer) => void = () => undefined
    const downloading = downloadBrowserShown(() => new Promise((resolve) => { finish = resolve }))
    expect(row()).toMatchObject({ state: 'downloading', receivedBytes: 0, local: { retry: false } })
    expect(row()?.totalBytes).toBeUndefined()
    finish({ ok: true })
    await expect(downloading).resolves.toEqual({ ok: true })
    expect(row()?.state).toBe('ready')
  })

  it('ends as failed in the Host\'s words, and answers what the Host answered', async () => {
    const refusal: BrowserInstallAnswer = { ok: false, reason: 'failed', message: 'The browser installer stopped.' }
    await expect(downloadBrowserShown(() => Promise.resolve(refusal))).resolves.toBe(refusal)
    expect(row()).toMatchObject({ state: 'failed', failure: { message: 'The browser installer stopped.' } })
  })
})
