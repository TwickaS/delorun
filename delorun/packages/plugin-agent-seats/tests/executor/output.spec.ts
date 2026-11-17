/** Capping a large program output: ends inline, full text through the spill store. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SpillStore, { SpillLocator, type SaveTextSpill, type SpillRef } from '@deepseek-ai/dsh-spill'
import { hasSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice'
import { describe, expect, it } from 'vitest'
import { cutOutput, SEAT_OUTPUT_CAP } from '../../src/executor/index.ts'
import { PREFIX, setup, TINY_CAP } from './helpers.ts'

class MemorySpill extends SpillStore {
  readonly saved: SaveTextSpill[] = []
  failWith: Error | undefined

  constructor(ctx: Context) {
    super(ctx)
  }

  override saveText(input: SaveTextSpill): Promise<SpillRef> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith)
    this.saved.push(input)
    return Promise.resolve({ locator: SpillLocator(`/spill/${this.saved.length}.txt`), bytes: Buffer.byteLength(input.content), retrievalHint: 'Read it with the read tool' })
  }
}

const BIG = `${'H'.repeat(8)}${'m'.repeat(100)}${'T'.repeat(6)}`

async function settle(output: string, isError: boolean, spill: 'saves' | 'fails' | 'absent') {
  const seat = await setup({ outputCap: TINY_CAP })
  let store: MemorySpill | undefined
  if (spill !== 'absent') {
    await seat.ctx.plugin(MemorySpill)
    store = seat.ctx.get('spillStore') as MemorySpill
    if (spill === 'fails') store.failWith = new Error('disk full')
  }
  const { agent, program } = await seatAgent(seat)
  program.finish('c1', output, isError)
  const batch = await seat.executor.execute({
    calls: [{ type: 'tool-call', id: ToolCallId('c1'), name: `${PREFIX}Bash`, arguments: '{}' }],
    signal: new AbortController().signal, agent, log: { turn: 1, step: 1 },
  })
  const [settled] = batch.results
  const content = settled?.result.content[0]
  return { store, agent, settled, text: content?.type === 'text' ? content.text : '' }
}

function seatAgent(seat: Awaited<ReturnType<typeof setup>>): Promise<{ agent: Agent; program: ReturnType<typeof seat.programs.live.get> & object }> {
  return seat.seatAgent(`output-${Math.random().toString(36).slice(2)}`)
}

describe('seat record output cap', () => {
  it('keeps head and tail inline and saves the full text through the spill store', async () => {
    const { store, text, agent, settled } = await settle(BIG, false, 'saves')

    expect(store?.saved).toHaveLength(1)
    expect(store?.saved[0]).toMatchObject({
      owner: { sessionId: agent.session.header.id },
      source: { kind: 'tool', toolName: `${PREFIX}Bash`, callId: 'c1', label: 'result' },
      content: BIG,
    })
    expect(text.startsWith(`HHHHHHHH\n\n[...]\n\nTTTTTT\n\n(`)).toBe(true)
    expect(text).toContain('100 bytes')
    expect(text).toContain('/spill/1.txt')
    expect(hasSpillNotice(text)).toBe(true)
    expect(settled?.result.isError).toBe(false)
    const logged = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(JSON.stringify(logged[0]?.data)).toContain('/spill/1.txt')
    expect(JSON.stringify(logged[0]?.data)).not.toContain('mmmmmmmmmm')
  })

  it('caps an error output the same way and keeps it an error', async () => {
    const { store, text, settled } = await settle(BIG, true, 'saves')

    expect(settled?.result.isError).toBe(true)
    expect(store?.saved).toHaveLength(1)
    expect(text).toContain('[...]')
  })

  it('leaves an output at the cap untouched and saves nothing', async () => {
    const { store, text } = await settle('x'.repeat(TINY_CAP.headChars + TINY_CAP.tailChars), false, 'saves')

    expect(store?.saved).toHaveLength(0)
    expect(text).toBe('x'.repeat(14))
  })

  it('still caps the inline text when the spill store fails, and says the full text was not saved', async () => {
    const { text } = await settle(BIG, false, 'fails')

    expect(text).toBe('HHHHHHHH\n\n[...]\n\nTTTTTT\n\n(100 bytes omitted. The full text could not be saved.)')
  })

  it('still caps the inline text when no spill store is loaded', async () => {
    const { text } = await settle(BIG, false, 'absent')

    expect(text).toBe('HHHHHHHH\n\n[...]\n\nTTTTTT\n\n(100 bytes omitted. The full text could not be saved.)')
  })
})

describe('cutOutput', () => {
  it('returns undefined for text that fits', () => {
    expect(cutOutput('short', SEAT_OUTPUT_CAP)).toBeUndefined()
  })

  it('never splits a surrogate pair at either cut', () => {
    const text = `${'a'.repeat(7)}😀${'b'.repeat(20)}😀${'c'.repeat(5)}`
    const cut = cutOutput(text, { headChars: 8, tailChars: 6 })
    expect(cut?.head).toBe('a'.repeat(7))
    expect(cut?.tail).toBe('c'.repeat(5))
    expect(cut?.omittedBytes).toBe(Buffer.byteLength(`😀${'b'.repeat(20)}😀`))
  })
})
