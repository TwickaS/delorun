import { describe, expect, it, vi } from 'vitest'
import { colourWanted, commandRows, createStyle, startSpinner, SPINNER_FRAMES, styleOf, unicodeWanted } from '../src/style.ts'

const TTY = { env: {}, isTTY: true, platform: 'linux' }
const PIPE = { env: {}, isTTY: false, platform: 'linux' }

describe('colour', () => {
  it('is on for a terminal and off for a pipe', () => {
    expect(colourWanted(TTY)).toBe(true)
    expect(colourWanted(PIPE)).toBe(false)
    expect(colourWanted({ ...TTY, env: { TERM: 'dumb' } })).toBe(false)
  })

  it('obeys NO_COLOR over everything, and FORCE_COLOR over the stream', () => {
    expect(colourWanted({ ...TTY, env: { NO_COLOR: '1' } })).toBe(false)
    expect(colourWanted({ ...TTY, env: { NO_COLOR: '1', FORCE_COLOR: '1' } })).toBe(false)
    expect(colourWanted({ ...PIPE, env: { FORCE_COLOR: '1' } })).toBe(true)
    expect(colourWanted({ ...TTY, env: { FORCE_COLOR: '0' } })).toBe(false)
    expect(colourWanted({ ...TTY, env: { FORCE_COLOR: 'false' } })).toBe(false)
    expect(colourWanted({ ...TTY, env: { NO_COLOR: '' } })).toBe(true)
  })
})

describe('marks', () => {
  it('draws Unicode marks in colour on a terminal', () => {
    const style = createStyle(TTY)
    expect(style.mark('ok', 'Done')).toBe('\u001b[32m✓\u001b[0m Done')
    expect(style.mark('warn', 'Careful')).toBe('\u001b[33m!\u001b[0m Careful')
    expect(style.mark('fail', 'Broke')).toBe('\u001b[31m✗\u001b[0m Broke')
    expect(style.mark('note', 'FYI')).toBe('\u001b[2m●\u001b[0m FYI')
    expect(style.command('delorun start')).toBe('\u001b[1mdelorun start\u001b[0m')
    expect(style.badge()).toBe('\u001b[38;5;208m\u001b[1mdelorun\u001b[0m\u001b[0m')
  })

  it('writes plain text with the same marks when colour is off', () => {
    const style = createStyle(PIPE)
    expect(style.mark('ok', 'Done')).toBe('✓ Done')
    expect(style.command('delorun start')).toBe('delorun start')
    expect(style.dim('why')).toBe('why')
    expect(style.badge()).toBe('delorun')
  })

  it('falls back to ASCII on a legacy Windows console only', () => {
    const legacy = { env: {}, isTTY: true, platform: 'win32' }
    expect(unicodeWanted(legacy)).toBe(false)
    expect(createStyle({ ...legacy, env: { NO_COLOR: '1' } }).mark('ok', 'Done')).toBe('+ Done')
    expect(createStyle({ ...legacy, env: { NO_COLOR: '1' } }).mark('fail', 'Broke')).toBe('x Broke')
    expect(unicodeWanted({ ...legacy, env: { WT_SESSION: 'x' } })).toBe(true)
    expect(unicodeWanted({ ...legacy, env: { TERM_PROGRAM: 'vscode' } })).toBe(true)
    expect(unicodeWanted({ ...legacy, env: { TERM: 'xterm-256color' } })).toBe(true)
    expect(unicodeWanted(PIPE)).toBe(true)
    expect(unicodeWanted({ ...PIPE, env: { TERM: 'linux' } })).toBe(false)
  })

  it('takes the stream from the process by default', () => {
    expect(styleOf({ NO_COLOR: '1' }).color).toBe(false)
    expect(styleOf({}, { isTTY: true }).color).toBe(true)
  })

  it('aligns commands with their explanations', () => {
    expect(commandRows(createStyle(PIPE), [['delorun open', 'open the studio'], ['delorun stop', 'stop it'], ['delorun logs --follow', 'watch it']])).toEqual([
      '  delorun open           open the studio',
      '  delorun stop           stop it',
      '  delorun logs --follow  watch it',
    ])
  })
})

describe('the spinner', () => {
  it('draws nothing off a terminal and returns the final line with the time', () => {
    const written: string[] = []
    let clock = 1000
    const spinner = startSpinner('Starting', createStyle(PIPE), { write: text => written.push(text) > 0 }, () => clock)
    clock = 3100
    expect(spinner.stop('ok', 'Delorun is running')).toBe('✓ Delorun is running (2.1s)')
    expect(written).toEqual([])
  })

  it('draws braille frames every 80 ms on a terminal, then clears its line', () => {
    vi.useFakeTimers()
    try {
      const written: string[] = []
      const spinner = startSpinner('Starting', createStyle(PIPE), { isTTY: true, write: text => written.push(text) > 0 })
      vi.advanceTimersByTime(160)
      expect(written).toEqual([`\r${SPINNER_FRAMES[0]} Starting`, `\r${SPINNER_FRAMES[1]} Starting`, `\r${SPINNER_FRAMES[2]} Starting`])
      spinner.stop('fail', 'Did not start')
      expect(written.at(-1)).toBe('\r\u001b[2K')
      vi.advanceTimersByTime(500)
      expect(written).toHaveLength(4)
    } finally {
      vi.useRealTimers()
    }
  })
})
