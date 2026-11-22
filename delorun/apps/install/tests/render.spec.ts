/**
 * The checklist a person reads while a release installs: a terminal's redrawn block, a log's plain lines, the bar's
 * rate and time left, a download that waits, and a narrow terminal.
 */
import { describe, expect, it } from 'vitest'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import type { SemanticVersion } from '@delorun/contract-release-manifest'
import type { InstallerProgress } from '../src/progress.ts'
import { createRenderer, InstallRenderer, type Every } from '../src/render.ts'

const VERSION = '0.1.0' as SemanticVersion
const NAME = 'delorun-0.1.0-linux-x64.tar.gz'
const TOTAL = 218_000_000
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/gu

/** A renderer over a fake clock and a fake timer; `tick` runs the timer's function. */
function harness(options: { readonly terminal: boolean, readonly columns?: number, readonly color?: boolean }) {
  const out: string[] = []
  let time = 1_000
  let timer: (() => void) | undefined
  let stopped = 0
  const every: Every = (fn) => { timer = fn; return () => { timer = undefined; stopped++ } }
  const renderer = new InstallRenderer({ write: (text) => { out.push(text) }, terminal: options.terminal, columns: () => options.columns ?? 100, color: options.color === true, now: () => time, every })
  return {
    renderer,
    out,
    advance: (ms: number) => { time += ms },
    tick: () => { timer?.() },
    running: () => timer !== undefined,
    stopped: () => stopped,
    text: () => out.join(''),
    /** The last block as the screen shows it: control sequences applied to the last drawn lines. */
    screen: () => { timer?.(); return screen(out.join('')).map(line => line.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u, '⠋')) },
    /** The block as it shows before any timer frame. */
    raw: () => screen(out.join('')),
  }
}

/** Apply `ESC[nF` (up n lines to column 0) and `ESC[J` (clear down) to what was written. */
function screen(written: string): string[] {
  const lines: string[] = ['']
  const parts = written.split(/(\u001B\[\d*F\u001B\[J)/u)
  for (const part of parts) {
    const move = /^\u001B\[(\d*)F\u001B\[J$/u.exec(part)
    if (move !== null) {
      const up = Number(move[1] === '' ? '1' : move[1])
      lines.length = Math.max(1, lines.length - up)
      lines[lines.length - 1] = ''
      continue
    }
    for (const char of part.split(/(\n)/u)) {
      if (char === '\n') lines.push('')
      else lines[lines.length - 1] += char
    }
  }
  return lines.filter(line => line !== '').map(line => line.replaceAll(ANSI, ''))
}

/**
 * A finished line as a terminal 100 columns wide shows it: the duration ends at column 80.
 * @param head - the mark and the text.
 * @param duration - the duration.
 * @returns the line.
 */
function aligned(head: string, duration: string): string {
  return head.padEnd(Math.max(head.length + 2, 80 - duration.length)) + duration
}

/** Drive an install to the start of its download. */
function untilDownload(h: ReturnType<typeof harness>): void {
  const events: InstallerProgress[] = [
    { step: 'resolving', channel: 'stable' },
    { step: 'resolved', channel: 'stable', version: VERSION },
    { step: 'signature-checked', version: VERSION, rootVersion: 2 },
    { step: 'log-checked', version: VERSION, state: 'verified' },
    { step: 'downloading', name: NAME, bytes: TOTAL },
  ]
  for (const event of events) {
    h.advance(400)
    h.renderer.handle(event)
  }
}

describe('a terminal', () => {
  it('shows a spinner line while a phase runs and a tick with its duration when it ends', () => {
    const h = harness({ terminal: true })
    h.renderer.handle({ step: 'resolving', channel: 'stable' })
    expect(h.raw()).toEqual(['⠋ Finding the release on the stable channel'])
    h.advance(400)
    h.tick()
    expect(h.raw()).toEqual(['⠙ Finding the release on the stable channel'])
    h.advance(300)
    h.renderer.handle({ step: 'resolved', channel: 'stable', version: VERSION })
    expect(h.raw()).toEqual([aligned('✔ Found release 0.1.0 on the stable channel', '0.7s'), '⠙ Checking the signature'])
    h.renderer.fail()
  })

  it('keeps the spinner turning, so the screen is never silent, and stops the timer when the install ends', () => {
    const h = harness({ terminal: true })
    h.renderer.handle({ step: 'resolving', channel: 'stable' })
    expect(h.running()).toBe(true)
    const before = h.out.length
    h.tick()
    h.tick()
    expect(h.out.length).toBe(before + 2)
    h.renderer.fail()
    expect(h.running()).toBe(false)
    expect(h.stopped()).toBe(1)
  })

  it('shows a live bar with the rate and the time left, smoothed over the last seconds', () => {
    const h = harness({ terminal: true })
    untilDownload(h)
    for (let second = 1; second <= 3; second++) {
      h.advance(1000)
      h.renderer.handle({ step: 'download-bytes', name: NAME, received: second * 6_700_000, total: TOTAL })
    }
    expect(h.screen().slice(-2)).toEqual([
      `⠋ Downloading ${NAME}`,
      '  ██░░░░░░░░░░░░░░░░░░░░░░    9%  20.1 / 218.0 MB  6.7 MB/s  ~30s left',
    ])
  })

  it('works the rate over the last five seconds only, so a faster stretch shows in it', () => {
    const h = harness({ terminal: true })
    untilDownload(h)
    let received = 0
    for (let second = 0; second < 6; second++) {
      h.advance(1000)
      received += 2_000_000
      h.renderer.handle({ step: 'download-bytes', name: NAME, received, total: TOTAL })
    }
    for (let second = 0; second < 6; second++) {
      h.advance(1000)
      received += 10_000_000
      h.renderer.handle({ step: 'download-bytes', name: NAME, received, total: TOTAL })
    }
    expect(h.screen().at(-1)).toContain('10.0 MB/s')
  })

  it('says it is estimating until a second of data gives a rate', () => {
    const h = harness({ terminal: true })
    untilDownload(h)
    h.advance(200)
    h.renderer.handle({ step: 'download-bytes', name: NAME, received: 400_000, total: TOTAL })
    expect(h.screen().at(-1)).toBe('  ░░░░░░░░░░░░░░░░░░░░░░░░    0%  0.4 / 218.0 MB  estimating…')
  })

  it('says it is estimating when the window holds no bytes', () => {
    const h = harness({ terminal: true })
    untilDownload(h)
    h.advance(1500)
    h.renderer.handle({ step: 'download-bytes', name: NAME, received: 0, total: TOTAL })
    expect(h.screen().at(-1)).toContain('estimating…')
  })

  it('shows a slow download as hours left rather than a wrong rate', () => {
    const h = harness({ terminal: true, columns: 120 })
    untilDownload(h)
    h.advance(1000)
    h.renderer.handle({ step: 'download-bytes', name: NAME, received: 10_000, total: TOTAL })
    h.advance(1000)
    h.renderer.handle({ step: 'download-bytes', name: NAME, received: 20_000, total: TOTAL })
    expect(h.screen().at(-1)).toContain('10 kB/s  ~6h 03m left')
  })

  it('shows a stalled download as waiting for data, counting the seconds', () => {
    const h = harness({ terminal: true })
    untilDownload(h)
    for (let second = 1; second <= 2; second++) {
      h.advance(1000)
      h.renderer.handle({ step: 'download-bytes', name: NAME, received: second * 6_700_000, total: TOTAL })
    }
    h.advance(12_000)
    h.tick()
    expect(h.screen().at(-1)).toBe('  █░░░░░░░░░░░░░░░░░░░░░░░    6%  13.4 / 218.0 MB  waiting for data… 12s')
    h.advance(1000)
    h.renderer.handle({ step: 'download-bytes', name: NAME, received: 20_100_000, total: TOTAL })
    expect(h.screen().at(-1)).not.toContain('waiting')
  })

  it('shortens the bar and then drops the time left, the rate and the amounts on a narrow terminal', () => {
    const wide = harness({ terminal: true, columns: 100 })
    untilDownload(wide)
    for (const h of [wide]) for (let second = 1; second <= 2; second++) { h.advance(1000); h.renderer.handle({ step: 'download-bytes', name: NAME, received: second * 126_400_000 / 2, total: TOTAL }) }
    expect(wide.screen().at(-1)).toBe('  ██████████████░░░░░░░░░░   57%  126.4 / 218.0 MB  63.2 MB/s  ~1.4s left')
    const widths = new Map<number, string>()
    for (const columns of [60, 40, 30, 22]) {
      const h = harness({ terminal: true, columns })
      untilDownload(h)
      for (let second = 1; second <= 2; second++) { h.advance(1000); h.renderer.handle({ step: 'download-bytes', name: NAME, received: second * 63_200_000, total: TOTAL }) }
      const last = h.screen().at(-1)!
      widths.set(columns, last)
      expect(last.length).toBeLessThan(columns)
    }
    expect(widths.get(60)).toBe('  █████████████░░░░░░░░░   57%  126.4 / 218.0 MB  63.2 MB/s')
    expect(widths.get(40)).toBe('  ████████░░░░░   57%  126.4 / 218.0 MB')
    expect(widths.get(30)).toBe('  ████████████░░░░░░░░░   57%')
  })

  it('cuts a label that does not fit and ends it with an ellipsis', () => {
    const h = harness({ terminal: true, columns: 24 })
    h.renderer.handle({ step: 'downloading', name: NAME, bytes: TOTAL })
    expect(h.screen()[0]).toBe('⠋ Downloading delorun-…')
  })

  it('ends the download with its size and average speed, then checks the hash', () => {
    const h = harness({ terminal: true })
    untilDownload(h)
    h.advance(32_000)
    h.renderer.handle({ step: 'downloaded', name: NAME, bytes: TOTAL })
    expect(h.screen().slice(-2)).toEqual([aligned('✔ Downloaded 218.0 MB at 6.8 MB/s average', '32s'), '⠋ Checking the download against its signed hash'])
    h.advance(900)
    h.renderer.handle({ step: 'download-verified', name: NAME })
    expect(h.screen().at(-1)).toBe(aligned('✔ Download matches its signed hash', '0.9s'))
  })

  it('shows the file count of an extraction and ends it with the total', () => {
    const h = harness({ terminal: true })
    h.renderer.handle({ step: 'unpacking', files: 3516 })
    h.advance(500)
    h.renderer.handle({ step: 'unpack-files', written: 1204, total: 3516 })
    expect(h.screen()).toEqual(['⠋ Unpacking the runtime', '  ████████░░░░░░░░░░░░░░░░   34%  1,204 / 3,516 files'])
    h.advance(4_000)
    h.renderer.handle({ step: 'unpack-files', written: 3516, total: 3516 })
    h.renderer.handle({ step: 'installing', version: '0.1.0' as RuntimeVersion })
    expect(h.screen().slice(-2)).toEqual([aligned('✔ Unpacked the runtime (3,516 files)', '4.5s'), '⠋ Installing release 0.1.0'])
    h.renderer.handle({ step: 'installed', version: '0.1.0' as RuntimeVersion })
    expect(h.screen().at(-1)).toBe(aligned('✔ Installed release 0.1.0', '0.0s'))
    h.renderer.fail()
  })

  it('ignores a file count when no extraction runs', () => {
    const h = harness({ terminal: true })
    h.renderer.handle({ step: 'unpack-files', written: 1, total: 2 })
    expect(h.out).toEqual([])
  })

  it('ends with one Next line after the tick of the last phase, and leaves no timer', () => {
    const h = harness({ terminal: true })
    h.renderer.handle({ step: 'starting' })
    h.renderer.finish('opening the studio')
    expect(h.screen()).toEqual([aligned('✔ Starting Delorun', '0.0s'), 'Next: opening the studio'])
    expect(h.running()).toBe(false)
  })

  it('prints no Next line when it has nothing to tell', () => {
    const h = harness({ terminal: true })
    h.renderer.handle({ step: 'starting' })
    h.renderer.finish()
    expect(h.screen()).toEqual([aligned('✔ Starting Delorun', '0.0s')])
    expect(h.running()).toBe(false)
  })

  it('marks the running phase failed and prints nothing else, so the error text that follows is the only reason shown', () => {
    const h = harness({ terminal: true })
    untilDownload(h)
    h.advance(2000)
    h.renderer.handle({ step: 'download-bytes', name: NAME, received: 1_000_000, total: TOTAL })
    h.renderer.fail()
    expect(h.screen().at(-1)).toBe(aligned(`✖ Downloading ${NAME}`, '2.0s'))
    expect(h.running()).toBe(false)
  })

  it('shows a later origin that serves the file again as a second download', () => {
    const h = harness({ terminal: true })
    untilDownload(h)
    h.renderer.handle({ step: 'downloaded', name: NAME, bytes: TOTAL })
    h.renderer.handle({ step: 'download-bytes', name: NAME, received: 1_000_000, total: TOTAL })
    expect(h.screen().slice(-2)[0]).toBe(`⠋ Downloading ${NAME} again`)
  })

  it('notes an origin that was skipped, and the warning of an unchecked release log', () => {
    const h = harness({ terminal: true })
    h.renderer.handle({ step: 'signature-checked', version: VERSION, rootVersion: 2 })
    h.renderer.handle({ step: 'log-checked', version: VERSION, state: 'unchecked', detail: 'the release log did not answer: connection refused' })
    h.renderer.handle({ step: 'origin-skipped', name: NAME, failed: 'releases.delorun.com', reason: 'the host answered 503', served: 'github.com' })
    expect(h.screen()).toEqual([
      '✔ Signature checked (release root 2)',
      aligned('! Release log not checked (the release log did not answer: connection refused)', '0.0s'),
      '  Warning: Release 0.1.0 has not been checked against the release log; Delorun checks it at the next connection.',
      '  releases.delorun.com did not serve delorun-0.1.0-linux-x64.tar.gz (the host answered 503); github.com served it, and its bytes verified.',
    ])
    h.renderer.fail()
  })

  it('says why the release log was not checked even when no reason came with the event', () => {
    const h = harness({ terminal: true })
    h.renderer.handle({ step: 'log-checked', version: VERSION, state: 'unchecked' })
    expect(h.screen()[0]).toContain('(the check did not run)')
  })

  it('uses no colour codes unless colour is on, and colours the marks and the durations when it is', () => {
    const plain = harness({ terminal: true })
    plain.renderer.handle({ step: 'resolved', channel: 'stable', version: VERSION })
    plain.renderer.fail()
    expect(plain.text().replaceAll(/\u001B\[\d*F\u001B\[J/gu, '')).not.toMatch(/\u001B\[\d+m/u)
    const coloured = harness({ terminal: true, color: true })
    coloured.renderer.handle({ step: 'resolving', channel: 'stable' })
    coloured.renderer.handle({ step: 'resolved', channel: 'stable', version: VERSION })
    coloured.renderer.handle({ step: 'log-checked', version: VERSION, state: 'unchecked' })
    coloured.renderer.handle({ step: 'downloading', name: NAME, bytes: TOTAL })
    coloured.renderer.fail()
    expect(coloured.text()).toContain('\u001B[32m✔\u001B[0m')
    expect(coloured.text()).toContain('\u001B[33m!\u001B[0m')
    expect(coloured.text()).toContain('\u001B[31m✖\u001B[0m')
    expect(coloured.text()).toContain('\u001B[2m')
    expect(coloured.text()).toContain('\u001B[36m')
  })
})

describe('the durations of a terminal', () => {
  it('end at one column, the width of the terminal up to 80 columns', () => {
    const wide = harness({ terminal: true, columns: 200 })
    wide.renderer.handle({ step: 'resolving', channel: 'stable' })
    wide.advance(400)
    wide.renderer.handle({ step: 'resolved', channel: 'stable', version: VERSION })
    wide.advance(65_000)
    wide.renderer.handle({ step: 'signature-checked', version: VERSION, rootVersion: 2 })
    expect(wide.raw().slice(0, 2).map(line => line.length)).toEqual([80, 80])
    wide.renderer.fail()
    const narrow = harness({ terminal: true, columns: 50 })
    narrow.renderer.handle({ step: 'resolving', channel: 'stable' })
    narrow.advance(400)
    narrow.renderer.handle({ step: 'resolved', channel: 'stable', version: VERSION })
    expect(narrow.raw()[0]!.length).toBe(49)
    narrow.renderer.fail()
  })

  it('are two spaces after a text that leaves no room, and after the text in a log', () => {
    const tight = harness({ terminal: true, columns: 30 })
    tight.renderer.handle({ step: 'resolving', channel: 'stable' })
    tight.advance(400)
    tight.renderer.handle({ step: 'resolved', channel: 'stable', version: VERSION })
    expect(tight.raw()[0]).toBe('✔ Found release 0.1.0 on the stable channel  0.4s')
    tight.renderer.fail()
  })
})

describe('a log', () => {
  it('prints one line for each phase, and none for a control sequence', () => {
    const h = harness({ terminal: false })
    untilDownload(h)
    h.advance(32_000)
    h.renderer.handle({ step: 'downloaded', name: NAME, bytes: TOTAL })
    h.renderer.handle({ step: 'download-verified', name: NAME })
    h.renderer.handle({ step: 'unpacking', files: 3516 })
    h.renderer.handle({ step: 'unpack-files', written: 3516, total: 3516 })
    h.renderer.handle({ step: 'installing', version: '0.1.0' as RuntimeVersion })
    h.renderer.handle({ step: 'installed', version: '0.1.0' as RuntimeVersion })
    h.renderer.handle({ step: 'starting' })
    h.renderer.finish('a few setup questions')
    expect(h.text()).not.toMatch(/\u001B/u)
    expect(h.text().split('\n')).toEqual([
      '✔ Found release 0.1.0 on the stable channel  0.4s',
      '✔ Signature checked (release root 2)  0.4s',
      '✔ Release log checked  0.4s',
      `Downloading ${NAME}…`,
      '✔ Downloaded 218.0 MB at 6.8 MB/s average  32s',
      '✔ Download matches its signed hash  0.0s',
      'Unpacking the runtime…',
      '  100%  3,516 / 3,516 files',
      '✔ Unpacked the runtime (3,516 files)  0.0s',
      '✔ Installed release 0.1.0  0.0s',
      '✔ Starting Delorun  0.0s',
      'Next: a few setup questions',
      '',
    ])
    expect(h.running()).toBe(false)
  })

  it('prints one line for each ten percent of a download, once, with the amounts and the rate', () => {
    const h = harness({ terminal: false })
    untilDownload(h)
    h.out.length = 0
    let received = 0
    for (let step = 0; step < 100; step++) {
      h.advance(1000)
      received += TOTAL / 100
      h.renderer.handle({ step: 'download-bytes', name: NAME, received, total: TOTAL })
    }
    const lines = h.text().split('\n').filter(line => line !== '')
    expect(lines).toHaveLength(10)
    expect(lines[0]).toBe('  10%  21.8 / 218.0 MB  2.2 MB/s')
    expect(lines[9]).toBe('  100%  218.0 / 218.0 MB  2.2 MB/s')
  })

  it('prints a line for a jump over several tenths, and nothing for a count that stays in the same tenth', () => {
    const h = harness({ terminal: false })
    untilDownload(h)
    h.out.length = 0
    h.renderer.handle({ step: 'download-bytes', name: NAME, received: 1_000_000, total: TOTAL })
    h.renderer.handle({ step: 'download-bytes', name: NAME, received: 120_000_000, total: TOTAL })
    expect(h.text()).toBe('  50%  120.0 / 218.0 MB\n')
  })

  it('prints a warning and a skipped origin as plain lines', () => {
    const h = harness({ terminal: false })
    h.renderer.handle({ step: 'log-checked', version: VERSION, state: 'unchecked', detail: 'offline' })
    expect(h.text()).toBe('! Release log not checked (offline)\n  Warning: Release 0.1.0 has not been checked against the release log; Delorun checks it at the next connection.\n')
  })

  it('starts no timer', () => {
    const h = harness({ terminal: false })
    h.renderer.handle({ step: 'resolving', channel: 'stable' })
    expect(h.running()).toBe(false)
  })

  it('reports an unpack that has no files as complete', () => {
    const h = harness({ terminal: false })
    h.renderer.handle({ step: 'unpacking', files: 0 })
    h.renderer.handle({ step: 'unpack-files', written: 0, total: 0 })
    expect(h.text()).toBe('Unpacking the runtime…\n  100%  0 / 0 files\n')
  })
})

describe('a plugin pack', () => {
  it('shows its own bar while it downloads, then its install, with a tick for each', () => {
    const h = harness({ terminal: true })
    h.renderer.handle({ step: 'pack-downloading', name: '@delorun/bundle-browser', bytes: 40_000_000 })
    h.advance(2000)
    h.renderer.handle({ step: 'pack-bytes', name: '@delorun/bundle-browser', received: 10_000_000, total: 40_000_000 })
    expect(h.screen()).toEqual(['⠋ Downloading plugin pack @delorun/bundle-browser', '  ██████░░░░░░░░░░░░░░░░░░   25%  10.0 / 40.0 MB  5.0 MB/s  ~6.0s left'])
    h.advance(6000)
    h.renderer.handle({ step: 'pack-installing', name: '@delorun/bundle-browser', bytes: 40_000_000 })
    expect(h.screen().slice(-2)).toEqual([aligned('✔ Downloaded plugin pack @delorun/bundle-browser 40.0 MB at 5.0 MB/s average', '8.0s'), '⠋ Installing plugin pack @delorun/bundle-browser'])
    h.advance(500)
    h.renderer.handle({ step: 'pack-installed', name: '@delorun/bundle-browser' })
    expect(h.screen().at(-1)).toBe(aligned('✔ Installed plugin pack @delorun/bundle-browser', '0.5s'))
    h.renderer.close()
    expect(h.running()).toBe(false)
  })

  it('shows a bar even when the first count arrives before its start event', () => {
    const h = harness({ terminal: true })
    h.renderer.handle({ step: 'pack-bytes', name: 'p', received: 1_000_000, total: 4_000_000 })
    expect(h.screen()[0]).toBe('⠋ Downloading plugin pack p')
  })

  it('prints a line for each ten percent in a log', () => {
    const h = harness({ terminal: false })
    h.renderer.handle({ step: 'pack-downloading', name: 'p', bytes: 1_000_000 })
    h.renderer.handle({ step: 'pack-bytes', name: 'p', received: 500_000, total: 1_000_000 })
    h.renderer.handle({ step: 'pack-installing', name: 'p', bytes: 1_000_000 })
    h.renderer.handle({ step: 'pack-installed', name: 'p' })
    expect(h.text().split('\n')).toEqual([
      'Downloading plugin pack p…',
      '  50%  0.5 / 1.0 MB',
      '✔ Downloaded plugin pack p 1.0 MB  0.0s',
      '✔ Installed plugin pack p  0.0s',
      '',
    ])
  })
})

describe('a question asked on the terminal', () => {
  it('clears the checklist while it is asked and draws the running phase again after', () => {
    const h = harness({ terminal: true })
    h.renderer.handle({ step: 'resolving', channel: 'stable' })
    h.renderer.suspend()
    expect(h.raw()).toEqual([])
    expect(h.running()).toBe(false)
    h.renderer.resume()
    expect(h.raw()).toEqual(['⠋ Finding the release on the stable channel'])
    expect(h.running()).toBe(true)
    h.renderer.fail()
  })

  it('has nothing to clear or draw in a log, or when no phase runs', () => {
    const log = harness({ terminal: false })
    log.renderer.suspend()
    log.renderer.resume()
    expect(log.out).toEqual([])
    const idle = harness({ terminal: true })
    idle.renderer.resume()
    expect(idle.out).toEqual([])
  })
})

describe('the end of a display', () => {
  it('close clears the block and drops a running phase without a line', () => {
    const h = harness({ terminal: true })
    h.renderer.handle({ step: 'resolving', channel: 'stable' })
    h.renderer.close()
    expect(h.raw()).toEqual([])
    expect(h.running()).toBe(false)
  })

  it('a failed step marks the running phase failed, as fail does', () => {
    const h = harness({ terminal: true })
    h.renderer.handle({ step: 'resolving', channel: 'stable' })
    h.advance(1500)
    h.renderer.handle({ step: 'failed' })
    expect(h.raw()).toEqual([aligned('✖ Finding the release on the stable channel', '1.5s')])
    expect(h.running()).toBe(false)
  })
})

describe('the renderer for a stream', () => {
  const stream = { isTTY: true, columns: 50 }
  const make = (stream: { isTTY?: boolean, columns?: number }, env: Record<string, string | undefined>) => {
    const out: string[] = []
    const renderer = createRenderer(text => { out.push(text) }, stream, env, { every: () => () => undefined })
    renderer.handle({ step: 'log-checked', version: VERSION, state: 'verified' })
    return out.join('')
  }

  it('redraws and colours a terminal', () => {
    expect(make(stream, {})).toContain('\u001B[32m✔')
  })

  it('writes no colour when NO_COLOR names anything, and colours when it is empty', () => {
    expect(make(stream, { NO_COLOR: '1' })).toBe('✔ Release log checked\n')
    expect(make(stream, { NO_COLOR: '' })).toContain('\u001B[32m')
  })

  it('writes plain lines for a stream that is not a terminal and for a dumb terminal', () => {
    expect(make({ isTTY: false }, {})).toBe('✔ Release log checked\n')
    expect(make({}, {})).toBe('✔ Release log checked\n')
    expect(make(stream, { TERM: 'dumb' })).toBe('✔ Release log checked\n')
  })

  it('takes the width from the stream, 80 columns when it has none', () => {
    const out: string[] = []
    const renderer = createRenderer(text => { out.push(text) }, { isTTY: true }, { NO_COLOR: '1' }, { every: () => () => undefined })
    renderer.handle({ step: 'downloading', name: 'x'.repeat(200), bytes: 10 })
    expect(out.join('').split('\n')[0]!.replace(/^\u001B\[\d+F\u001B\[J/u, '').length).toBe(79)
    renderer.close()
  })
})
