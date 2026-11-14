/**
 * The upstream lines `delorun` renames: a line that starts with `dsh:` and a `dsh plugin` command spelling in a hint.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { brandUpstreamOutput, withBrandedStderr } from '../src/upstream-output.ts'

const INITIALIZED = 'dsh: initialized profile staging at /home/person/.delorun/profiles/staging\n'

describe('upstream output', () => {
  const original = process.stderr.write
  afterEach(() => { process.stderr.write = original })

  it('names delorun in the profile-initialized line', () => {
    expect(brandUpstreamOutput(INITIALIZED)).toBe('delorun: initialized profile staging at /home/person/.delorun/profiles/staging\n')
  })

  it.each([
    ['a warning', 'dsh: warning: a plugin declares no dsh.bundle\n', 'delorun: warning: a plugin declares no dsh.bundle\n'],
    ['a failed command', 'dsh: plugin command failed; diagnostics: /profile/log\n', 'delorun: plugin command failed; diagnostics: /profile/log\n'],
    ['a missing pnpm', 'dsh: pnpm was not found; install pnpm and make it available on PATH.\n', 'delorun: pnpm was not found; install pnpm and make it available on PATH.\n'],
    ['a rejected installation with its restoration', '\ndsh: installation rejected: a@1.0.0 needs more\ndsh: profile files restored.\n', '\ndelorun: installation rejected: a@1.0.0 needs more\ndelorun: profile files restored.\n'],
    ['a hint naming the allow-version command', 'dsh: to accept the risk, run: dsh plugin --profile default allow-version a@1.0.0 --dsh-version 0.2.2 --accept-risk\n', 'delorun: to accept the risk, run: delorun plugin --profile default allow-version a@1.0.0 --dsh-version 0.2.2 --accept-risk\n'],
    ['a hint quoting the allow-version command mid-sentence', 'with `dsh plugin allow-version` or the plugin manager, then retry\n', 'with `delorun plugin allow-version` or the plugin manager, then retry\n'],
    ['a hint naming remove', "use a supported Host or remove it with 'dsh plugin remove <package>'.\n", "use a supported Host or remove it with 'delorun plugin remove <package>'.\n"],
  ])('renames %s', (_name, text, expected) => {
    expect(brandUpstreamOutput(text)).toBe(expected)
  })

  it.each([
    'Progress: resolved 10, reused 10\n',
    'a note: dsh: initialized profile x\n',
    'the runtime is dsh 0.2.2 and restart dsh.\n',
    'dsh plugins are listed elsewhere\n',
  ])('leaves %j as it is', text => {
    expect(brandUpstreamOutput(text)).toBe(text)
  })

  it('rewrites the lines written to standard error during the run and restores standard error after it', async () => {
    const written: unknown[] = []
    const recorder = ((chunk: unknown) => { written.push(chunk); return true }) as typeof process.stderr.write
    process.stderr.write = recorder
    const result = await withBrandedStderr(() => {
      process.stderr.write(INITIALIZED)
      process.stderr.write('dsh: warning: kept\n')
      process.stderr.write('Progress: unchanged\n')
      return Promise.resolve(7)
    })
    expect(result).toBe(7)
    expect(written).toEqual([
      'delorun: initialized profile staging at /home/person/.delorun/profiles/staging\n',
      'delorun: warning: kept\n',
      'Progress: unchanged\n',
    ])
    expect(process.stderr.write).toBe(recorder)
  })

  it('restores standard error when the run throws', async () => {
    const recorder = (() => true) as typeof process.stderr.write
    process.stderr.write = recorder
    await expect(withBrandedStderr(() => Promise.reject(new Error('pnpm failed')))).rejects.toThrow('pnpm failed')
    expect(process.stderr.write).toBe(recorder)
  })
})
