import { describe, expect, it } from 'vitest'
import { BACK, BACK_CHOICE, BACK_HINT, runSteps, stepIO, type RunStep } from '../../src/setup/steps.ts'
import { scriptedPrompter, type Answer, type Recording } from './support.ts'

/**
 * @param script - the answers in order.
 * @returns a prompter that plays them, and its recording.
 */
function play(script: readonly Answer[]): { prompter: ReturnType<typeof scriptedPrompter>, recording: Recording } {
  const recording: Recording = { screen: [], asked: [] }
  return { prompter: scriptedPrompter(script, recording), recording }
}

describe('the questions of a step', () => {
  it('adds a back choice to select and yes-or-no questions only when an earlier step asks', async () => {
    const first = play(['b', true])
    const without = stepIO(first.prompter, false)
    expect(await without.select('Pick', [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], 'a')).toBe('b')
    expect(await without.confirm('Sure?', false)).toBe(true)
    expect(first.recording.screen.join('\n')).not.toContain('Back')

    const second = play(['a', 'no', BACK_CHOICE, BACK_CHOICE])
    const withBack = stepIO(second.prompter, true)
    expect(withBack.canGoBack).toBe(true)
    expect(await withBack.select('Pick', [{ value: 'a', label: 'A' }], 'a')).toBe('a')
    expect(await withBack.confirm('Sure?', true)).toBe(false)
    expect(await withBack.select('Pick', [{ value: 'a', label: 'A' }], 'a')).toBe(BACK)
    expect(await withBack.confirm('Sure?', true)).toBe(BACK)
    expect(second.recording.screen.join('\n')).toContain('← Back')
  })

  it('treats an empty key or text as back only when an earlier step asks', async () => {
    const without = stepIO(play(['key', 'text']).prompter, false)
    expect(await without.secret('Key')).toBe('key')
    expect(await without.text('Name', 'x', () => undefined)).toBe('text')

    const played = play(['', '', 'typed', 'value'])
    const withBack = stepIO(played.prompter, true)
    expect(await withBack.secret('Key')).toBe(BACK)
    expect(await withBack.text('Name', 'x', () => 'never asked for an empty entry')).toBe(BACK)
    expect(await withBack.secret('Key')).toBe('typed')
    expect(await withBack.text('Name', 'x', () => undefined)).toBe('value')
    expect(played.recording.asked[0]).toBe(`secret: Key ${BACK_HINT}`)
    withBack.note('body', 'Title')
    expect(played.recording.screen).toContain('# Title')
  })
})

describe('running steps with a way back', () => {
  /**
   * A step that asks a select and appends the answer to the state.
   * @param name - the step's name and question.
   * @param asks - whether it asks in a state.
   * @returns the step.
   */
  function ask(name: string, asks: (state: string[]) => boolean = () => true): RunStep<string[]> {
    return {
      asks,
      async run(io, state) {
        const answer = await io.select(name, [{ value: 'one', label: '1' }, { value: 'two', label: '2' }], 'one')
        return answer === BACK ? BACK : [...state, `${name}=${answer}`]
      },
    }
  }

  it('re-asks the nearest earlier step that asks, from the state it started with', async () => {
    const quiet: RunStep<string[]> = { asks: () => false, run: (_io, state) => Promise.resolve([...state, 'quiet']) }
    const { prompter, recording } = play(['one', 'two', BACK_CHOICE, 'two', 'one'])
    const steps = [ask('a'), quiet, ask('b'), ask('c')]
    // a=one; b=two; c goes back to b (the quiet step is not re-asked); b=two again; c=one.
    expect(await runSteps(steps, [], prompter)).toEqual(['a=one', 'quiet', 'b=two', 'c=one'])
    expect(recording.asked).toEqual(['select: a', 'select: b', 'select: c', 'select: b', 'select: c'])
  })

  it('skips steps that do not ask in the current state when going back', async () => {
    const conditional = ask('b', state => !state.includes('a=two'))
    const skipping: RunStep<string[]> = { ...conditional, async run(io, state) { return state.includes('a=two') ? [...state, 'b skipped'] : conditional.run(io, state) } }
    const { prompter, recording } = play(['two', BACK_CHOICE, 'one', 'two', 'one'])
    // a=two (b is skipped); c goes back to a, not to the skipped b; a=one; b=two; c=one.
    expect(await runSteps([ask('a'), skipping, ask('c')], [], prompter)).toEqual(['a=one', 'b=two', 'c=one'])
    expect(recording.asked).toEqual(['select: a', 'select: c', 'select: a', 'select: b', 'select: c'])
  })

  it('offers no way back on the first question', async () => {
    const { prompter, recording } = play(['one'])
    await runSteps([ask('a')], [], prompter)
    expect(recording.screen.join('\n')).not.toContain('Back')
  })
})
