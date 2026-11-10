/**
 * The terminal questions: without a terminal on both standard input and
 * standard output the answer is the empty string, which every caller treats
 * as no; with one, the trimmed answer the person typed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const typed = vi.hoisted(() => ({ answer: '', closed: 0 }))

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: async () => typed.answer,
    close: () => { typed.closed++ },
  }),
}))

const { askOnTerminal, isYes } = await import('../../src/trash/terminal.ts')

/**
 * Set whether standard input and standard output are terminals.
 * @param input - standard input's state.
 * @param output - standard output's state.
 */
function terminals(input: boolean | undefined, output: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: input, configurable: true })
  Object.defineProperty(process.stdout, 'isTTY', { value: output, configurable: true })
}

const original = { input: process.stdin.isTTY, output: process.stdout.isTTY }

afterEach(() => {
  terminals(original.input, original.output)
})

describe('a terminal question', () => {
  it('answers the empty string without a terminal on both streams, and asks nothing', async () => {
    terminals(undefined, true)
    expect(await askOnTerminal('Delete? ')).toBe('')
    terminals(true, false)
    expect(await askOnTerminal('Delete? ')).toBe('')
    expect(typed.closed).toBe(0)
  })

  it('returns the trimmed answer and closes the prompt', async () => {
    terminals(true, true)
    typed.answer = '  yes  '

    expect(await askOnTerminal('Delete? ')).toBe('yes')
    expect(typed.closed).toBe(1)
  })

  it('reads y and yes in any case as yes, and everything else as no', () => {
    expect(['y', 'Y', 'yes', 'YES'].map(isYes)).toEqual([true, true, true, true])
    expect(['', 'n', 'no', 'yess', ' y'].map(isYes)).toEqual([false, false, false, false, false])
  })
})
