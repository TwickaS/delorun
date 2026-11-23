/**
 * What `delorun update` shows of the install the home process runs: the launcher's checklist, drawn from the install
 * events of the home process's progress lines.
 */
import { describe, expect, it } from 'vitest'
import { updateDisplay } from '../../src/update/progress.ts'

/** A display over a plain stream, with what it wrote. */
function plain(): { readonly display: ReturnType<typeof updateDisplay>, readonly written: () => string } {
  let out = ''
  const display = updateDisplay({ stdout: (text) => { out += text }, stderr: () => {} }, {}, { isTTY: false })
  return { display, written: () => out }
}

describe('the display of an update request', () => {
  it('prints each phase the home process names and each text line it sends as they are', () => {
    const { display, written } = plain()
    display.onLine({ ok: true, phase: 'checking' })
    display.onLine({ ok: true, line: 'a line from an older home process\n' })
    expect(written()).toBe('… checking\na line from an older home process\n')
  })

  it('draws the install events of a progress line as the launcher does', () => {
    const { display, written } = plain()
    display.onLine({ ok: true, install: { step: 'resolving', channel: 'stable' } })
    display.onLine({ ok: true, install: { step: 'resolved', channel: 'stable', version: '1.1.0' } })
    display.onLine({ ok: true, install: { step: 'installed', version: '1.1.0' } })
    expect(written().split('\n').map(line => line.replace(/ {2}\d+(\.\d)?s$/u, ''))).toEqual([
      '✔ Found release 1.1.0 on the stable channel',
      '✔ Installed release 1.1.0',
      '',
    ])
  })

  it('ignores a value that is not an install step, and a line that is not ok', () => {
    const { display, written } = plain()
    display.onLine({ ok: true, install: { step: 'rm -rf' } })
    display.onLine({ ok: true, install: 'resolved' })
    display.onLine({ ok: false, install: { step: 'resolving', channel: 'stable' }, phase: 'checking', line: 'x' })
    display.report({ step: 'unknown' })
    expect(written()).toBe('')
  })

  it('asks a question without the checklist drawn over it, then goes on', async () => {
    let out = ''
    const display = updateDisplay({ stdout: (text) => { out += text }, stderr: () => {} }, { NO_COLOR: '1' }, { isTTY: true, columns: 60 })
    display.report({ step: 'resolving', channel: 'stable' })
    const before = out
    const answer = await display.asking(() => {
      expect(out.length).toBeGreaterThan(before.length)
      return Promise.resolve('yes')
    })
    expect(answer).toBe('yes')
    expect(out.endsWith('Finding the release on the stable channel\n')).toBe(true)
    display.fail()
  })

  it('puts the question\'s failure back to the caller and draws the checklist again', async () => {
    const display = updateDisplay({ stdout: () => {}, stderr: () => {} }, {}, { isTTY: true })
    display.report({ step: 'resolving', channel: 'stable' })
    await expect(display.asking(() => Promise.reject(new Error('no terminal')))).rejects.toThrow('no terminal')
    display.close()
  })

  it('marks the running phase failed when the request fails, and ends quietly when it was answered', () => {
    let out = ''
    const display = updateDisplay({ stdout: (text) => { out += text }, stderr: () => {} }, { NO_COLOR: '1' }, { isTTY: true })
    display.report({ step: 'resolving', channel: 'stable' })
    display.fail()
    expect(out).toContain('✖ Finding the release on the stable channel')
    const calm = updateDisplay({ stdout: () => {}, stderr: () => {} }, {}, { isTTY: true })
    calm.report({ step: 'resolving', channel: 'stable' })
    calm.close()
  })
})
