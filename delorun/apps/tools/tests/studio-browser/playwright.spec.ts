import { describe, expect, it } from 'vitest'
import { createPlaywrightAdapter, loopbackOrigin, parseWorkerAnswer, type BrowseDeps, type ProcessResult } from '../../src/studio-browser/index.ts'
import { parseSteps } from '../../src/studio-browser/steps.ts'

/**
 * Dependencies whose one process answers with `result`, recording the call.
 * @param result - what the worker process leaves behind.
 * @returns the dependencies and the calls seen.
 */
function harness(result: ProcessResult): { deps: BrowseDeps, calls: { args: readonly string[], input?: string }[] } {
  const calls: { args: readonly string[], input?: string }[] = []
  const deps: BrowseDeps = {
    run: (_file, args, options) => {
      calls.push({ args, ...(options.input === undefined ? {} : { input: options.input }) })
      return result
    },
    env: {},
    randomHex: () => '0',
    writeTemp: () => '/tmp/x',
    removeTemp: () => undefined,
  }
  return { deps, calls }
}

describe('parseWorkerAnswer', () => {
  it('reads the last line', () => {
    expect(parseWorkerAnswer('noise\n{"ok":true,"output":"1","recording":"/a.webm"}\n')).toEqual({ ok: true, output: '1', recording: '/a.webm' })
  })

  it.each(['', 'not json', '{"ok":"yes","output":""}', '[]'])('ignores %j', text => {
    expect(parseWorkerAnswer(text)).toBeUndefined()
  })
})

describe('the playwright adapter', () => {
  const spec = { origin: loopbackOrigin('http://127.0.0.1:9/'), startUrl: 'http://127.0.0.1:9/', timeoutMs: 1000, viewport: { width: 390, height: 844 }, scheme: 'dark' as const }

  it('sends the run to the worker as JSON and returns its answer', () => {
    const { deps, calls } = harness({ status: 0, stdout: '{"ok":true,"output":"\\"x\\""}\n', stderr: '' })
    expect(createPlaywrightAdapter(deps).run(spec)).toEqual({ ok: true, output: '"x"' })
    expect(JSON.parse(calls[0]?.input ?? '{}')).toMatchObject({ viewport: { width: 390, height: 844 }, scheme: 'dark', origin: 'http://127.0.0.1:9' })
    expect(calls[0]?.args.at(-1)).toMatch(/playwright-worker\.ts$/)
  })

  it('reports a worker that printed no answer', () => {
    const { deps } = harness({ status: 1, stdout: '', stderr: 'boom' })
    expect(createPlaywrightAdapter(deps).run(spec)).toEqual({ ok: false, output: 'the Playwright worker failed (exit 1):\nboom' })
  })

  it('checks by asking the worker to launch Chromium', () => {
    const { deps, calls } = harness({ status: 0, stdout: '{"ok":true,"output":"Chromium 1"}', stderr: '' })
    expect(createPlaywrightAdapter(deps).check()).toEqual({ ok: true, detail: 'Chromium 1' })
    expect(calls[0]?.input).toBe('{"check":true}')
  })
})

describe('parseSteps', () => {
  it('accepts every action and makes screenshot paths absolute', () => {
    const text = JSON.stringify([{ goto: '/settings' }, { click: 'a' }, { type: { selector: 'input', text: 'hi' } }, { press: 'Enter' }, { waitFor: 'main' }, { waitMs: 50 }, { screenshot: 'a.png' }])
    expect(parseSteps(text, '/w').at(-1)).toEqual({ screenshot: '/w/a.png' })
  })

  it.each([
    ['not JSON', 'x', 'not JSON'],
    ['not a list', '{}', 'not a list of steps'],
    ['unknown action', '[{"hover":"a"}]', 'not a list of steps'],
    ['two actions in one step', '[{"click":"a","press":"b"}]', 'not a list of steps'],
    ['screenshot that is not a png', '[{"screenshot":"a.jpg"}]', '.png'],
  ])('rejects %s', (_label, text, message) => {
    expect(() => parseSteps(text, '/w')).toThrow(message)
  })
})
