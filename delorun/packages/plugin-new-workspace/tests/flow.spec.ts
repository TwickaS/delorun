import { describe, expect, it } from 'vitest'
import { canCreateNow, INITIAL, isLastScreen, reduce, SCREENS, STEP_TOTAL, safetyProblem, stepNumber, type FlowAction, type FlowState } from '../src/client/flow.ts'

const PARENT = '/home/person/Projects'

/** Apply actions in order from a state. */
const run = (actions: readonly FlowAction[], from: FlowState = INITIAL): FlowState => actions.reduce(reduce, from)

describe('the flow\'s first screen', () => {
  it('opens on the how screen with nothing chosen and the safe choices made, in step 1 of 5', () => {
    expect(INITIAL).toEqual({
      step: 'how', method: undefined, choice: undefined, picking: undefined, browser: undefined, model: undefined,
      safety: { permission: 'files', access: 'open', hosts: '' }, problem: undefined,
    })
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
  it('counts the screens from one array, and finishes on the last of them', () => {
    expect(SCREENS).toEqual(['how', 'where', 'browser', 'model', 'safety'])
    expect(STEP_TOTAL).toBe(SCREENS.length)
    expect(['how', 'folder', 'new-folder', 'clone', 'browser', 'model', 'safety'].map(step => stepNumber(step as 'how'))).toEqual([1, 2, 2, 2, 3, 4, 5])
    expect(['how', 'folder', 'new-folder', 'clone', 'browser', 'model', 'safety'].map(step => isLastScreen(step as 'how'))).toEqual([false, false, false, false, false, false, true])
  })
})

describe('the browser, model and safety screens', () => {
  const onFolder = run([{ type: 'method', method: 'new-folder', parent: PARENT }, { type: 'continue' }, { type: 'edit-new', change: { name: 'site' } }])
  const onBrowser = reduce(onFolder, { type: 'continue' })
  const onModel = reduce(onBrowser, { type: 'continue' })

  it('goes from the second screen to the browser screen, then the model screen, then the safety screen, which has nothing after it', () => {
    expect([onBrowser.step, stepNumber(onBrowser.step)]).toEqual(['browser', 3])
    expect([onModel.step, stepNumber(onModel.step)]).toEqual(['model', 4])
    const onSafety = reduce(onModel, { type: 'continue' })
    expect([onSafety.step, stepNumber(onSafety.step)]).toEqual(['safety', 5])
    expect(reduce(onSafety, { type: 'continue' })).toBe(onSafety)
  })

  it('keeps the browser choice once made, and none before', () => {
    expect(onBrowser.browser).toBeUndefined()
    expect(run([{ type: 'browser', choice: 'none' }], onBrowser).browser).toBe('none')
    expect(run([{ type: 'browser', choice: 'none' }, { type: 'continue' }, { type: 'back' }], onBrowser).browser).toBe('none')
  })

  it('goes on from a folder on this computer once one is chosen, and from a clone once it started', () => {
    const folder = run([{ type: 'method', method: 'folder', parent: PARENT }, { type: 'continue' }])
    expect(reduce(folder, { type: 'continue' })).toBe(folder)
    expect(run([{ type: 'existing', path: '/home/person/src' }, { type: 'continue' }], folder).step).toBe('browser')
    const clone = run([{ type: 'method', method: 'clone', parent: PARENT }, { type: 'continue' }])
    expect(reduce(clone, { type: 'continue' })).toBe(clone)
    expect(run([{ type: 'clone-started', job: 'job-1' }, { type: 'continue' }], clone).step).toBe('browser')
  })

  it('does not go on while a place is being picked', () => {
    const picking = reduce(onFolder, { type: 'pick-place' })
    expect(reduce(picking, { type: 'continue' })).toBe(picking)
  })

  it('goes back one screen at a time, to the second screen of the card chosen', () => {
    const onSafety = reduce(onModel, { type: 'continue' })
    expect(reduce(onSafety, { type: 'back' }).step).toBe('model')
    expect(reduce(onModel, { type: 'back' }).step).toBe('browser')
    expect(reduce(onBrowser, { type: 'back' }).step).toBe('new-folder')
    const clone = run([{ type: 'method', method: 'clone', parent: PARENT }, { type: 'continue' }, { type: 'clone-started', job: 'j' }, { type: 'continue' }, { type: 'back' }])
    expect(clone.step).toBe('clone')
    expect(clone.choice).toMatchObject({ job: 'j' })
  })

  it('forgets a started clone when the clone\'s fields or place change, since it is another clone', () => {
    const started = run([{ type: 'method', method: 'clone', parent: PARENT }, { type: 'continue' }, { type: 'clone-started', job: 'j' }])
    expect(reduce(started, { type: 'edit-clone', change: { url: 'https://example.com/b.git' } }).choice).not.toHaveProperty('job')
    const picked = run([{ type: 'pick-place' }, { type: 'place-picked', path: '/home/person/src' }], started)
    expect(picked.choice).toEqual({ kind: 'clone', url: '', branch: '', parent: '/home/person/src', name: '' })
  })

  it('keeps the model pick and the safety choices, changing only the fields given', () => {
    const picked = run([
      { type: 'model', pick: { provider: 'deepseek', model: 'flash', effort: 'on' } },
      { type: 'safety', change: { access: 'allowlist' } }, { type: 'safety', change: { hosts: 'pypi.org' } }, { type: 'safety', change: { permission: 'full' } },
    ], onModel)
    expect(picked.model).toEqual({ provider: 'deepseek', model: 'flash', effort: 'on' })
    expect(picked.safety).toEqual({ permission: 'full', access: 'allowlist', hosts: 'pypi.org' })
  })

  it('offers Create now from the browser screen onward, once a place is chosen and the safety choices are usable', () => {
    expect([INITIAL, onFolder, onBrowser, onModel, reduce(onModel, { type: 'continue' })].map(canCreateNow)).toEqual([false, false, true, true, true])
    const noPlace = { ...onModel, choice: undefined }
    expect(canCreateNow(noPlace)).toBe(false)
    expect(canCreateNow(run([{ type: 'safety', change: { access: 'allowlist' } }], onModel))).toBe(false)
    expect(canCreateNow(run([{ type: 'safety', change: { access: 'allowlist', hosts: 'pypi.org' } }], onModel))).toBe(true)
  })

  it('reads the hosts only for an allowlist', () => {
    expect(safetyProblem({ permission: 'files', access: 'open', hosts: 'not a host' })).toBeUndefined()
    expect(safetyProblem({ permission: 'files', access: 'allowlist', hosts: '' })).toEqual({ kind: 'empty' })
    expect(safetyProblem({ permission: 'files', access: 'allowlist', hosts: 'a.example\nnope' })).toEqual({ kind: 'invalid', host: 'nope' })
    expect(safetyProblem({ permission: 'files', access: 'allowlist', hosts: 'a.example' })).toBeUndefined()
  })

  it('shows a refusal of the place on the second screen, and a lock where the person pressed', () => {
    expect(reduce(onModel, { type: 'finish-failed', problem: { kind: 'create', problem: 'exists' } })).toMatchObject({ step: 'new-folder', problem: { kind: 'create', problem: 'exists' } })
    expect(reduce(onModel, { type: 'finish-failed', problem: { kind: 'locked' } })).toMatchObject({ step: 'model', problem: { kind: 'locked' } })
    const recent = run([{ type: 'finish-failed', problem: { kind: 'place', problem: 'home-directory' } }])
    expect(recent.step).toBe('how')
  })
})
