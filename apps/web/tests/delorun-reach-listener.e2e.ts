/**
 * The studio in Chromium on Delorun's reach listener (contract C4), under the listener's Content Security Policy. The
 * studio boots and a sidebar terminal renders styled with no policy violation, so the page evaluates no string and
 * every `<style>` element it creates carries the response's nonce. A chat reply holding a remote-image Markdown tag
 * renders a placeholder naming the image's host on the reach listener, while a stand-in server for that host, and the
 * page's own request log, record no request for it; the same Session on the loopback listener loads the image.
 */
import { once } from 'node:events'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { createTestAuthority } from '../../../delorun/apps/tools/src/stack/certificates.ts'
import { openReachStudio, policyViolations } from './delorun-reach.ts'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

const IMAGE_HOST = 'images.example.net'
const REPLY = `Here is the chart: ![sales chart](https://${IMAGE_HOST}/chart.png)`
/** A 1×1 transparent PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const TERMINAL_PATCH = fileURLToPath(new URL('./fixtures/sidebar-terminal.patch.yml', import.meta.url))

/** Send one message and wait until the turn settles. */
async function send(page: Page, settled: () => Promise<unknown>, text: string): Promise<void> {
  const done = settled()
  const input = page.locator('[data-composer-input]').first()
  await input.fill(text)
  await input.press('Enter')
  await done
}

/** A scaffold whose model replies {@link REPLY} to every turn. */
async function launchWithReply() {
  const root = await mkdtemp(join(tmpdir(), 'delorun-reach-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const llm = await startMockLlmServer({ sequence: ['success'], repeatLast: true, successText: REPLY })
  onTestFinished(() => llm.close())
  const key = credentialRef('DELORUN_REACH_BROWSER_KEY')
  const overlay = join(root, 'model.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL: llm.baseURL, apiKeyEnv: key } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
  ]))
  const scaffold = await launchWebScaffold({ deepSeekMissingCredential: true, extraOverlayPath: [overlay, TERMINAL_PATCH] })
  onTestFinished(() => scaffold.close())
  await scaffold.ctx.credentials.set(key, 'reach-browser-test-key')
  return scaffold
}

describe.skipIf(webSnapshotMode() === 'record')('Delorun reach listener', () => {
  it.skipIf(process.platform === 'win32')('the studio boots and styles a terminal with no policy violation', async () => {
    const scaffold = await launchWithReply()
    const studio = await openReachStudio(scaffold, await createTestAuthority('Delorun reach e2e'))
    const page = await studio.context.newPage()
    onTestFailed(() => saveFailureShot(page, 'web-e2e-delorun-reach-terminal'))
    const response = await page.goto(studio.url)
    expect(response?.status()).toBe(200)
    const policy = await response?.headerValue('content-security-policy') ?? ''
    expect(policy).toMatch(/^default-src 'self'; script-src 'self' 'nonce-[A-Za-z0-9_-]{22}';/)
    expect(policy).not.toContain('unsafe-eval')
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'reach')

    const expand = page.locator('[data-sidebar-right-expand]')
    if (await expand.isVisible()) await expand.click()
    const entry = page.locator('[data-sidebar-right-guide-entry="terminal"]')
    if (!await entry.isVisible()) await page.locator('[data-dockkit-add-tab]').click()
    await entry.getByRole('button', { name: /^New terminal/u }).click()
    await expect.poll(async () => await page.locator('.xterm-rows:visible').innerText()).toContain('bash-')

    // xterm's own stylesheet hides its input element, and each of its runtime <style> elements applies.
    const helper = page.locator('.xterm-helper-textarea:visible')
    expect(await helper.evaluate(element => getComputedStyle(element).opacity)).toBe('0')
    const styles = await page.evaluate(() => [...document.querySelectorAll('style')].map(style => ({ applied: style.sheet !== null, xterm: style.closest('.xterm') !== null })))
    expect(styles.filter(style => style.xterm).length).toBeGreaterThan(0)
    expect(styles.filter(style => !style.applied)).toEqual([])
    expect(await policyViolations(page)).toEqual([])
  })

  it('a remote image in chat is never requested', async () => {
    const authority = await createTestAuthority('Delorun reach e2e')
    const imageTls = await authority.issue({ dnsNames: [IMAGE_HOST] })
    if (imageTls.keyPem === undefined) throw new Error('the test authority returned no key')

    // The remote host's stand-in records every request that reaches it.
    const imageRequests: string[] = []
    const images = createHttpsServer({ cert: imageTls.pem, key: imageTls.keyPem }, (req, res) => {
      imageRequests.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG)
    })
    images.listen(0, '127.0.0.1')
    await once(images, 'listening')
    onTestFinished(() => new Promise<void>((resolve) => { images.close(() => { resolve() }); images.closeAllConnections() }))
    const imagePort = (images.address() as AddressInfo).port

    const scaffold = await launchWithReply()
    const studio = await openReachStudio(scaffold, authority, [`MAP ${IMAGE_HOST}:443 127.0.0.1:${String(imagePort)}`])

    // The reach listener: the page loads under the reach policy and the reply's image renders as a placeholder.
    const page = await studio.context.newPage()
    onTestFailed(() => saveFailureShot(page, 'web-e2e-delorun-remote-image-reach'))
    const reachRequests: string[] = []
    page.on('request', (request) => { reachRequests.push(request.url()) })
    const response = await page.goto(studio.url)
    expect(response?.status()).toBe(200)
    expect(await response?.headerValue('content-security-policy')).toMatch(/img-src 'self' data: blob:; media-src 'self' data:/)
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'reach')
    await send(page, () => scaffold.whenTurnSettled(), 'Show the chart')
    const placeholder = page.getByRole('img', { name: `Image from ${IMAGE_HOST} not loaded: sales chart` })
    await placeholder.waitFor()
    expect(await placeholder.textContent()).toBe(`Image from ${IMAGE_HOST} not loaded`)
    expect(await page.locator(`img[src*="${IMAGE_HOST}"]`).count()).toBe(0)
    // Give a request that the page might still make time to arrive, then check both network records.
    await page.waitForTimeout(1000)
    expect(imageRequests).toEqual([])
    expect(reachRequests.filter(url => new URL(url).hostname === IMAGE_HOST)).toEqual([])
    expect(reachRequests.length).toBeGreaterThan(0)
    expect(await policyViolations(page)).toEqual([])

    // Control: the same Session on the loopback listener requests the image, so the stand-in records what a page fetches.
    const loopback = await studio.context.newPage()
    onTestFailed(() => saveFailureShot(loopback, 'web-e2e-delorun-remote-image-loopback'))
    await loopback.goto(scaffold.authenticatedUrl)
    await loopback.getByText('Show the chart', { exact: true }).first().click()
    await loopback.getByRole('img', { name: 'sales chart' }).waitFor()
    await expect.poll(() => imageRequests.length).toBeGreaterThan(0)
  })
})
