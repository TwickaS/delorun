import { describe, expect, it } from 'vitest'
import type { DelorunLogger } from '@delorun/logs'
import { runAfterStart, type StartRequest } from '../src/start.ts'

/** @returns a request whose output is recorded, with the given afterStart. */
function request(afterStart?: () => Promise<void>): { start: StartRequest, out: string[], err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, start: { home: '/h', profile: 'default', open: true, env: {}, output: { stdout: text => void out.push(text), stderr: text => void err.push(text) }, ...afterStart === undefined ? {} : { afterStart } } }
}

/** @returns a logger that records its error records. */
function logger(): { log: Pick<DelorunLogger, 'error'>, errors: string[] } {
  const errors: string[] = []
  return { errors, log: { error: (message: string) => void errors.push(message) } }
}

describe('the work after a start', () => {
  it('runs once, awaited, and prints nothing itself', async () => {
    const steps: string[] = []
    const { start, out, err } = request(async () => { await Promise.resolve(); steps.push('ran') })
    await runAfterStart(start, logger().log)
    expect(steps).toEqual(['ran'])
    expect([out, err]).toEqual([[], []])
  })

  it('does nothing when the start has none', async () => {
    const { start, err } = request()
    await runAfterStart(start, logger().log)
    expect(err).toEqual([])
  })

  it('reports a failure on standard error and in the home log, and does not throw, so the process keeps running', async () => {
    const { start, err } = request(() => Promise.reject(new Error('the prompt broke')))
    const { log, errors } = logger()
    await expect(runAfterStart(start, log)).resolves.toBeUndefined()
    expect(err.join('')).toBe('delorun: a step after the start failed: the prompt broke\nDelorun keeps running.\n')
    expect(errors).toEqual(['a step after the start failed: the prompt broke'])
  })
})
