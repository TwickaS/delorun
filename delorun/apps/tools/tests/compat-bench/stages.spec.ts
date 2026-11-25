import { describe, expect, it } from 'vitest'
import { hostNotes, timed } from '../../src/compat-bench/stages.ts'

describe('timing a stage', () => {
  it('measures the work rather than the moment before it started', async () => {
    const result = await timed('screens', async () => {
      await new Promise(done => setTimeout(done, 30))
      return { status: 'pass', failures: [], facts: { 'console errors': 0 } }
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(20)
    expect(result).toMatchObject({ name: 'screens', status: 'pass', facts: { 'console errors': 0 } })
  })

  it('turns a thrown error into a failed stage naming its cause', async () => {
    const result = await timed('install', async () => { throw new Error('Cannot find package dsh-x') })
    expect(result.status).toBe('fail')
    expect(result.failures[0]?.cause).toBe('load-error')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })
})

describe('the host report a card keeps', () => {
  const doctor = [
    '✓ home: the Delorun home resolves.',
    '8 passed · 3 warnings · 1 failed',
    '! docker: Docker is not installed.',
    '✗ key: the DeepSeek API key is malformed.',
    '',
  ].join('\n')

  it('keeps the summary and the lines that report a problem, and drops the passes', () => {
    expect(hostNotes('delorun doctor', doctor)).toEqual([
      'delorun doctor: 8 passed · 3 warnings · 1 failed',
      'delorun doctor: ! docker: Docker is not installed.',
      'delorun doctor: ✗ key: the DeepSeek API key is malformed.',
    ])
  })

  it('keeps a failed line of delorun verify', () => {
    expect(hostNotes('delorun verify', 'failed   release-signature  the trusted root does not read\nnot run  runtime-files')).toEqual([
      'delorun verify: failed   release-signature  the trusted root does not read',
    ])
  })

  it('says nothing when the host printed nothing', () => {
    expect(hostNotes('delorun doctor', '')).toEqual([])
  })
})
