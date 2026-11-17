import { describe, expect, it } from 'vitest'
import { INITIAL, isLastScreen, reduce, SCREENS, STEP_TOTAL, stepNumber, type FlowAction, type FlowState } from '../src/client/flow.ts'

const PARENT = '/home/person/Projects'

/** Apply actions in order from a state. */
const run = (actions: readonly FlowAction[], from: FlowState = INITIAL): FlowState => actions.reduce(reduce, from)

describe('the flow\'s first screen', () => {
  it('opens on the how screen with nothing chosen, in step 1 of 5', () => {
    expect(INITIAL).toEqual({ step: 'how', method: undefined, choice: undefined, picking: undefined, problem: undefined })
    expect([stepNumber(INITIAL.step), STEP_TOTAL]).toEqual([1, 5])
  })

  it('does not go on until a way to start is chosen', () => {
    expect(reduce(INITIAL, { type: 'continue' })).toBe(INITIAL)
  })

  it('prefills a new folder with the default place and Git ticked, and a clone with the default place', () => {
    expect(run([{ type: 'method', method: 'new-folder', parent: PARENT }]).choice).toEqual({ kind: 'new', parent: PARENT, name: '', git: true })
    expect(run([{ type: 'method', method: 'clone', parent: PARENT }]).choice).toEqual({ kind: 'clone', url: '', branch: '', parent: PARENT, name: '' })
    expect(run([{ type: 'method', method: 'folder', parent: PARENT }]).choice).toBeUndefined()
  })

  it('goes to the screen of the card chosen, which is step 2', () => {
    const state = run([{ type: 'method', method: 'clone', parent: PARENT }, { type: 'continue' }])
    expect([state.step, stepNumber(state.step)]).toEqual(['clone', 2])
  })
})

describe('the second screen', () => {
  const onNewFolder = run([{ type: 'method', method: 'new-folder', parent: PARENT }, { type: 'continue' }])

  it('keeps what was typed when the person goes back and chooses the same card, and starts over for another card', () => {
    const typed = run([{ type: 'edit-new', change: { name: 'my-project', git: false } }], onNewFolder)
    const back = run([{ type: 'back' }, { type: 'method', method: 'new-folder', parent: PARENT }], typed)
    expect(back.choice).toEqual({ kind: 'new', parent: PARENT, name: 'my-project', git: false })
    expect(run([{ type: 'back' }, { type: 'method', method: 'clone', parent: PARENT }], typed).choice).toEqual({ kind: 'clone', url: '', branch: '', parent: PARENT, name: '' })
  })

  it('changes only the fields of the kind of choice it holds', () => {
    expect(run([{ type: 'edit-clone', change: { url: 'https://example.com/a.git' } }], onNewFolder)).toBe(onNewFolder)
    const cloning = run([{ type: 'method', method: 'clone', parent: PARENT }, { type: 'edit-clone', change: { url: 'https://example.com/a.git', branch: 'dev' } }])
    expect(cloning.choice).toMatchObject({ kind: 'clone', url: 'https://example.com/a.git', branch: 'dev', parent: PARENT })
  })

  it('goes back to the first screen, and stays there when it is already there', () => {
    expect(run([{ type: 'back' }], onNewFolder).step).toBe('how')
    expect(reduce(INITIAL, { type: 'back' })).toBe(INITIAL)
  })

  it('picks a place on the folder screen and returns to the screen that asked with the place as the parent', () => {
    const picking = run([{ type: 'pick-place' }], onNewFolder)
    expect([picking.step, picking.picking]).toEqual(['folder', 'new-folder'])
    const picked = run([{ type: 'place-picked', path: '/home/person/src' }], picking)
    expect([picked.step, picked.picking, picked.choice]).toEqual(['new-folder', undefined, { kind: 'new', parent: '/home/person/src', name: '', git: true }])
  })

  it('returns from a place picker without changing the place when the person goes back', () => {
    const picking = run([{ type: 'pick-place' }], onNewFolder)
    const back = reduce(picking, { type: 'back' })
    expect([back.step, back.picking, back.choice]).toEqual(['new-folder', undefined, onNewFolder.choice])
  })

  it('cannot pick a place from the first screen, nor return a place when none was asked for', () => {
    expect(reduce(INITIAL, { type: 'pick-place' })).toBe(INITIAL)
    expect(reduce(onNewFolder, { type: 'place-picked', path: '/x' })).toBe(onNewFolder)
  })

  it('shows a reason in place until the next edit or move clears it', () => {
    const refused = reduce(onNewFolder, { type: 'problem', problem: { kind: 'create', problem: 'exists' } })
    expect(refused.problem).toEqual({ kind: 'create', problem: 'exists' })
    expect(reduce(refused, { type: 'edit-new', change: { name: 'other' } }).problem).toBeUndefined()
    expect(reduce(refused, { type: 'back' }).problem).toBeUndefined()
  })
})

describe('a clone', () => {
  const cloning = run([
    { type: 'method', method: 'clone', parent: PARENT }, { type: 'continue' },
    { type: 'edit-clone', change: { url: 'https://example.com/site.git', name: 'site' } },
  ])

  it('records the job once it started', () => {
    expect(reduce(cloning, { type: 'clone-started', job: 'job-1' }).choice).toMatchObject({ kind: 'clone', job: 'job-1' })
  })

  it('brings the person back to the clone screen with the reason, and drops the job', () => {
    const away = run([{ type: 'clone-started', job: 'job-1' }, { type: 'back' }], cloning)
    const failed = reduce(away, { type: 'clone-failed', failure: 'not-found' })
    expect(failed.step).toBe('clone')
    expect(failed.problem).toEqual({ kind: 'clone-failed', failure: 'not-found' })
    expect(failed.choice).toEqual({ kind: 'clone', url: 'https://example.com/site.git', branch: '', parent: PARENT, name: 'site' })
  })
})

describe('the screens list', () => {
  it('counts the screens built so far from one array, and finishes on the last of them', () => {
    expect(SCREENS).toEqual(['how', 'where'])
    expect(isLastScreen('how')).toBe(false)
    expect(['folder', 'new-folder', 'clone'].map(step => isLastScreen(step as 'folder'))).toEqual([true, true, true])
  })
})
