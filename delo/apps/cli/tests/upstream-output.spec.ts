/**
 * The one upstream line `delorun` renames: the announcement of a profile a plugin operation initialized.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { brandUpstreamOutput, withBrandedStderr } from '../src/upstream-output.ts'

const INITIALIZED = 'dsh: initialized profile staging at /home/person/.delo/profiles/staging\n'

describe('upstream output', () => {
  const original = process.stderr.write
  afterEach(() => { process.stderr.write = original })

  it('names delorun in the profile-initialized line', () => {
    expect(brandUpstreamOutput(INITIALIZED)).toBe('delorun: initialized profile staging at /home/person/.delo/profiles/staging\n')
  })

  it.each([
    'dsh: warning: a plugin declares no dsh.bundle\n',
    'Progress: resolved 10, reused 10\n',
    'a note: dsh: initialized profile x\n',
  ])('leaves %j as it is', text => {
    expect(brandUpstreamOutput(text)).toBe(text)
  })

  it('rewrites the line written to standard error during the run and restores standard error after it', async () => {
    const written: unknown[] = []
    const recorder = ((chunk: unknown) => { written.push(chunk); return true }) as typeof process.stderr.write
    process.stderr.write = recorder
    const result = await withBrandedStderr(() => {
      process.stderr.write(INITIALIZED)
      process.stderr.write('dsh: warning: kept\n')
      return Promise.resolve(7)
    })
    expect(result).toBe(7)
    expect(written).toEqual(['delorun: initialized profile staging at /home/person/.delo/profiles/staging\n', 'dsh: warning: kept\n'])
    expect(process.stderr.write).toBe(recorder)
  })

  it('restores standard error when the run throws', async () => {
    const recorder = (() => true) as typeof process.stderr.write
    process.stderr.write = recorder
    await expect(withBrandedStderr(() => Promise.reject(new Error('pnpm failed')))).rejects.toThrow('pnpm failed')
    expect(process.stderr.write).toBe(recorder)
  })
})
