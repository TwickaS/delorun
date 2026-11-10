import { describe, expect, it } from 'vitest'
import type { RowToast, RowToastState } from '../src/client/contract/slots.ts'
import { createNoticeHold } from '../src/client/notice-hold.ts'

/** A notice channel that records what it shows and holds the notice showing now. */
function channel() {
  const shown: RowToast[] = []
  let now: RowToastState | null = null
  let seq = 0
  const hold = createNoticeHold(
    (toast) => { shown.push(toast); now = { ...toast, seq: ++seq } },
    () => now,
    () => { now = null },
  )
  return { hold, shown, current: () => now }
}

const FAILED: RowToast = { kind: 'defaultWorkspaceFailed' }

describe('the default Workspace notice hold', () => {
  it('shows every notice at once while nothing holds it, as stock does', () => {
    const c = channel()
    c.hold.notify(FAILED)
    c.hold.notify({ kind: 'pinFailed' })
    expect(c.shown).toEqual([FAILED, { kind: 'pinFailed' }])
  })

  it('keeps the default Workspace notice back while held, and only that notice', () => {
    const c = channel()
    const release = c.hold.hold()
    c.hold.notify(FAILED)
    c.hold.notify({ kind: 'pinFailed' })
    expect(c.shown).toEqual([{ kind: 'pinFailed' }])
    release()
    expect(c.shown).toEqual([{ kind: 'pinFailed' }, FAILED])
  })

  it('withdraws the notice already showing when a hold starts, and shows it again on release', () => {
    const c = channel()
    c.hold.notify(FAILED)
    const release = c.hold.hold()
    expect(c.current()).toBeNull()
    release()
    expect(c.shown).toEqual([FAILED, FAILED])
  })

  it('leaves another notice showing when a hold starts', () => {
    const c = channel()
    c.hold.notify({ kind: 'pinFailed' })
    c.hold.hold()
    expect(c.current()?.kind).toBe('pinFailed')
  })

  it('drops the kept notice when the holder told the person', () => {
    const c = channel()
    const release = c.hold.hold()
    c.hold.notify(FAILED)
    release({ told: true })
    expect(c.shown).toEqual([])
  })

  it('shows the kept notice only when the last hold ends, and counts each release once', () => {
    const c = channel()
    const first = c.hold.hold()
    const second = c.hold.hold()
    c.hold.notify(FAILED)
    first()
    first()
    expect(c.shown).toEqual([])
    second()
    expect(c.shown).toEqual([FAILED])
  })

  it('shows nothing on release when nothing was kept', () => {
    const c = channel()
    c.hold.hold()()
    expect(c.shown).toEqual([])
  })
})
