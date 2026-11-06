/** Switch-on recording of preset_inspect in the Standard preset, replayed keyless. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, fixtureUserPrompts, launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/delo-preset-inspect', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v4.jsonl')
const MODE = webSnapshotMode()
const PROMPT = 'Which modes does this harness offer? Use preset_inspect.'
// The corpus model. A first live record has no primary Session for the replay model layer to follow, so the driver selects it.
const CORPUS_MODEL = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

/** The Session event fields this driver reads. */
type RecordedEvent = { type: string; data?: { name?: string } }

describe('web e2e: delo-preset-inspect switch-on turn', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      compareReplaySession: true,
      presetInspect: true,
      ...(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 5 }),
    })
    await scaffold.ctx.agentDefaultModel.saveSelection(CORPUS_MODEL)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // Fresh world: connecting a workspace births the blank session whose composer accepts the prompt.
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('drives the recorded prompt to a settled turn (all modes)', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-delo-preset-inspect'))
    if (MODE !== 'record') {
      // Drift guard: the committed fixture must carry exactly the drive prompt.
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    // Arm the turn-boundary waiter before sending, so a burst replay cannot miss the turn end.
    const settled = scaffold.whenTurnSettled()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled
    if (MODE === 'record') {
      await recordFixture(scaffold, sessionId, FIXTURE)
    }
  }, 180_000)

  it.skipIf(MODE === 'record')('calls preset_inspect in the recorded turn', async () => {
    const events = (await readFile(FIXTURE, 'utf8')).split('\n').filter(Boolean).map((line): RecordedEvent => JSON.parse(line))
    expect(events.some(event => event.type === 'tool/call' && event.data?.name === 'preset_inspect')).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  })

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v4.jsonl', 'system-prompt.expected.md', 'tool-schemas.expected.json'])
  })
})
